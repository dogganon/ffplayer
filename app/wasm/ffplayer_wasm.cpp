#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <algorithm>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavformat/avio.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/imgutils.h>
#include <libavutil/mem.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

using emscripten::val;

namespace {

struct RangeReader {
    val data = val::undefined();
    std::int64_t size = 0;
    std::int64_t pos = 0;
};

struct DecoderState {
    AVCodecContext* ctx = nullptr;
    SwsContext* sws = nullptr;
    SwrContext* swr = nullptr;
    AVChannelLayout out_layout{};
    val frames = val::array();
    std::vector<float> audio;
};

std::runtime_error av_error(const char* what, int err) {
    char buf[AV_ERROR_MAX_STRING_SIZE] = {};
    av_strerror(err, buf, sizeof(buf));
    return std::runtime_error(std::string(what) + ": " + buf);
}

int read_packet(void* opaque, std::uint8_t* dst, int dst_size) {
    auto& r = *static_cast<RangeReader*>(opaque);
    if (r.pos >= r.size) {
        return AVERROR_EOF;
    }
    const auto remaining = r.size - r.pos;
    const int requested = static_cast<int>(std::min<std::int64_t>(remaining, dst_size));
    val chunk = r.data.call<val>("read", static_cast<double>(r.pos), requested).await();
    if (chunk.isNull() || chunk.isUndefined()) return AVERROR(EIO);
    const int n = chunk["byteLength"].as<int>();
    if (n <= 0 || n > requested) return AVERROR(EIO);
    val heap = val::module_property("HEAPU8");
    heap.call<void>("set", chunk, reinterpret_cast<std::uintptr_t>(dst));
    r.pos += n;
    return n;
}

std::int64_t seek(void* opaque, std::int64_t offset, int whence) {
    auto& r = *static_cast<RangeReader*>(opaque);
    if (whence == AVSEEK_SIZE) {
        return r.size;
    }
    whence &= ~AVSEEK_FORCE;
    std::int64_t base = 0;
    if (whence == SEEK_CUR) base = r.pos;
    else if (whence == SEEK_END) base = r.size;
    else if (whence != SEEK_SET) return AVERROR(EINVAL);
    const std::int64_t next = base + offset;
    if (next < 0 || next > r.size) {
        return AVERROR(EINVAL);
    }
    r.pos = next;
    return next;
}

RangeReader make_range_reader(const val& source) {
    const auto size = static_cast<std::int64_t>(source["size"].as<double>());
    if (size <= 0) {
        throw std::invalid_argument("input is empty");
    }
    return RangeReader{source, size, 0};
}

val bytes_to_uint8_array(const std::uint8_t* data, std::size_t size) {
    return val::global("Uint8Array").new_(emscripten::typed_memory_view(size, data));
}

val floats_to_float32_array(const float* data, std::size_t size) {
    return val::global("Float32Array").new_(emscripten::typed_memory_view(size, data));
}

double stream_start_time(const AVStream* stream) {
    if (stream->start_time == AV_NOPTS_VALUE) {
        return 0.0;
    }
    return static_cast<double>(stream->start_time) * av_q2d(stream->time_base);
}

double timeline_start_time(const AVFormatContext* fmt) {
    if (fmt->start_time != AV_NOPTS_VALUE) {
        return static_cast<double>(fmt->start_time) / AV_TIME_BASE;
    }

    double start = 0.0;
    bool saw_start = false;
    for (unsigned i = 0; i < fmt->nb_streams; ++i) {
        const AVStream* stream = fmt->streams[i];
        if (stream->start_time == AV_NOPTS_VALUE) continue;
        const double stream_start = stream_start_time(stream);
        start = saw_start ? std::min(start, stream_start) : stream_start;
        saw_start = true;
    }
    return saw_start ? start : 0.0;
}

double frame_time(const AVFrame* frame, const AVStream* stream, double timeline_start) {
    const std::int64_t pts = frame->best_effort_timestamp;
    if (pts == AV_NOPTS_VALUE) {
        return std::max(0.0, stream_start_time(stream) - timeline_start);
    }
    const double t = static_cast<double>(pts) * av_q2d(stream->time_base);
    return std::max(0.0, t - timeline_start);
}

AVPixelFormat choose_software_format(AVCodecContext*, const AVPixelFormat* formats) {
    for (const AVPixelFormat* p = formats; *p != AV_PIX_FMT_NONE; ++p) {
        const AVPixFmtDescriptor* desc = av_pix_fmt_desc_get(*p);
        if (desc && !(desc->flags & AV_PIX_FMT_FLAG_HWACCEL)) {
            return *p;
        }
    }
    return formats[0];
}

const AVCodec* find_decoder(const AVCodecParameters* par) {
    if (par->codec_id == AV_CODEC_ID_AV1) {
        if (const AVCodec* dav1d = avcodec_find_decoder_by_name("libdav1d")) {
            return dav1d;
        }
    }
    return avcodec_find_decoder(par->codec_id);
}

val metadata_to_js(const AVDictionary* metadata) {
    val out = val::object();
    const AVDictionaryEntry* entry = nullptr;
    while ((entry = av_dict_iterate(metadata, entry))) {
        out.set(std::string(entry->key), std::string(entry->value));
    }
    return out;
}

void push_video_frame(DecoderState& state, const AVFrame* frame, const AVStream* stream, double timeline_start) {
    if (!state.sws) {
        state.sws = sws_getContext(
            frame->width,
            frame->height,
            static_cast<AVPixelFormat>(frame->format),
            frame->width,
            frame->height,
            AV_PIX_FMT_RGBA,
            SWS_BILINEAR,
            nullptr,
            nullptr,
            nullptr
        );
        if (!state.sws) {
            throw std::runtime_error("sws_getContext failed");
        }
    }

    std::vector<std::uint8_t> rgba(static_cast<std::size_t>(frame->width) * frame->height * 4);
    std::uint8_t* dst[] = {rgba.data()};
    int linesize[] = {frame->width * 4};
    sws_scale(state.sws, frame->data, frame->linesize, 0, frame->height, dst, linesize);

    val out = val::object();
    out.set("time", frame_time(frame, stream, timeline_start));
    out.set("width", frame->width);
    out.set("height", frame->height);
    out.set("rgba", bytes_to_uint8_array(rgba.data(), rgba.size()));
    state.frames.call<void>("push", out);
}

void append_audio_frame(DecoderState& state, const AVFrame* frame) {
    if (!state.swr) {
        av_channel_layout_default(&state.out_layout, frame->ch_layout.nb_channels > 1 ? 2 : 1);
        int ret = swr_alloc_set_opts2(
            &state.swr,
            &state.out_layout,
            AV_SAMPLE_FMT_FLT,
            frame->sample_rate,
            &frame->ch_layout,
            static_cast<AVSampleFormat>(frame->format),
            frame->sample_rate,
            0,
            nullptr
        );
        if (ret < 0 || !state.swr) {
            throw av_error("swr_alloc_set_opts2 failed", ret);
        }
        ret = swr_init(state.swr);
        if (ret < 0) {
            throw av_error("swr_init failed", ret);
        }
    }

    const int out_channels = state.out_layout.nb_channels;
    const int capacity = swr_get_out_samples(state.swr, frame->nb_samples);
    std::vector<float> converted(static_cast<std::size_t>(capacity) * out_channels);
    std::uint8_t* out[] = {reinterpret_cast<std::uint8_t*>(converted.data())};
    const int samples = swr_convert(state.swr, out, capacity, const_cast<const std::uint8_t**>(frame->data), frame->nb_samples);
    if (samples < 0) {
        throw av_error("swr_convert failed", samples);
    }
    converted.resize(static_cast<std::size_t>(samples) * out_channels);
    state.audio.insert(state.audio.end(), converted.begin(), converted.end());
}

void drain_decoder(DecoderState& state, const AVStream* stream, double timeline_start) {
    auto* frame = av_frame_alloc();
    if (!frame) throw std::bad_alloc();

    while (true) {
        const int ret = avcodec_receive_frame(state.ctx, frame);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;
        if (ret < 0) {
            av_frame_free(&frame);
            throw av_error("avcodec_receive_frame failed", ret);
        }
        if (state.ctx->codec_type == AVMEDIA_TYPE_VIDEO) {
            push_video_frame(state, frame, stream, timeline_start);
        } else if (state.ctx->codec_type == AVMEDIA_TYPE_AUDIO) {
            append_audio_frame(state, frame);
        }
        av_frame_unref(frame);
    }

    av_frame_free(&frame);
}

}  // namespace

static val decode_js(const val& source) {
    RangeReader reader = make_range_reader(source);

    constexpr int io_buffer_size = 32 * 1024;
    auto* io_buffer = static_cast<std::uint8_t*>(av_malloc(io_buffer_size));
    if (!io_buffer) throw std::bad_alloc();

    AVIOContext* io = avio_alloc_context(io_buffer, io_buffer_size, 0, &reader, &read_packet, nullptr, &seek);
    if (!io) {
        av_free(io_buffer);
        throw std::runtime_error("avio_alloc_context failed");
    }

    AVFormatContext* fmt = avformat_alloc_context();
    if (!fmt) {
        av_freep(&io->buffer);
        avio_context_free(&io);
        throw std::bad_alloc();
    }
    fmt->pb = io;
    fmt->flags |= AVFMT_FLAG_CUSTOM_IO;

    int ret = avformat_open_input(&fmt, nullptr, nullptr, nullptr);
    if (ret < 0) throw av_error("avformat_open_input failed", ret);
    ret = avformat_find_stream_info(fmt, nullptr);
    if (ret < 0) throw av_error("avformat_find_stream_info failed", ret);
    const double timeline_start = timeline_start_time(fmt);

    std::vector<DecoderState> decoders(fmt->nb_streams);
    val tracks = val::array();

    for (unsigned i = 0; i < fmt->nb_streams; ++i) {
        AVStream* stream = fmt->streams[i];
        const AVCodecParameters* par = stream->codecpar;
        val track = val::object();
        track.set("index", static_cast<int>(i));
        track.set("id", stream->id);
        track.set("type", av_get_media_type_string(par->codec_type) ? av_get_media_type_string(par->codec_type) : "unknown");
        track.set("codec", avcodec_get_name(par->codec_id));
        track.set("metadata", metadata_to_js(stream->metadata));
        track.set("timeBase", av_q2d(stream->time_base));
        if (par->codec_type == AVMEDIA_TYPE_VIDEO) {
            track.set("width", par->width);
            track.set("height", par->height);
        } else if (par->codec_type == AVMEDIA_TYPE_AUDIO) {
            track.set("sampleRate", par->sample_rate);
            track.set("channels", par->ch_layout.nb_channels);
        }

        if (par->codec_type == AVMEDIA_TYPE_VIDEO || par->codec_type == AVMEDIA_TYPE_AUDIO) {
            const AVCodec* codec = find_decoder(par);
            if (codec) {
                AVCodecContext* ctx = avcodec_alloc_context3(codec);
                if (!ctx) throw std::bad_alloc();
                ret = avcodec_parameters_to_context(ctx, par);
                if (ret < 0) throw av_error("avcodec_parameters_to_context failed", ret);
                ctx->get_format = choose_software_format;
                ret = avcodec_open2(ctx, codec, nullptr);
                if (ret < 0) {
                    track.set("decodeError", std::string("decoder open failed"));
                    avcodec_free_context(&ctx);
                } else {
                    decoders[i].ctx = ctx;
                    track.set("decodable", true);
                }
            } else {
                track.set("decodeError", std::string("no decoder in wasm build"));
            }
        }
        tracks.call<void>("push", track);
    }

    AVPacket* pkt = av_packet_alloc();
    if (!pkt) throw std::bad_alloc();
    while ((ret = av_read_frame(fmt, pkt)) >= 0) {
        if (pkt->stream_index >= 0 && pkt->stream_index < static_cast<int>(decoders.size())) {
            auto& decoder = decoders[static_cast<std::size_t>(pkt->stream_index)];
            if (decoder.ctx) {
                const int send_ret = avcodec_send_packet(decoder.ctx, pkt);
                if (send_ret >= 0) {
                    drain_decoder(decoder, fmt->streams[pkt->stream_index], timeline_start);
                }
            }
        }
        av_packet_unref(pkt);
    }

    for (unsigned i = 0; i < fmt->nb_streams; ++i) {
        auto& decoder = decoders[i];
        if (!decoder.ctx) continue;
        avcodec_send_packet(decoder.ctx, nullptr);
        drain_decoder(decoder, fmt->streams[i], timeline_start);

        val track = tracks[i];
        if (decoder.ctx->codec_type == AVMEDIA_TYPE_VIDEO) {
            track.set("frames", decoder.frames);
        } else if (decoder.ctx->codec_type == AVMEDIA_TYPE_AUDIO) {
            const int channels = decoder.out_layout.nb_channels ? decoder.out_layout.nb_channels : decoder.ctx->ch_layout.nb_channels;
            track.set("channels", channels);
            track.set("sampleRate", decoder.ctx->sample_rate);
            track.set("samples", floats_to_float32_array(decoder.audio.data(), decoder.audio.size()));
        }
    }

    av_packet_free(&pkt);
    for (auto& decoder : decoders) {
        if (decoder.sws) sws_freeContext(decoder.sws);
        if (decoder.swr) swr_free(&decoder.swr);
        if (decoder.out_layout.nb_channels) av_channel_layout_uninit(&decoder.out_layout);
        if (decoder.ctx) avcodec_free_context(&decoder.ctx);
    }

    val out = val::object();
    out.set("ffmpegVersion", av_version_info());
    out.set("format", fmt->iformat && fmt->iformat->name ? fmt->iformat->name : "");
    out.set("durationSeconds", fmt->duration != AV_NOPTS_VALUE ? static_cast<double>(fmt->duration) / AV_TIME_BASE : 0.0);
    out.set("metadata", metadata_to_js(fmt->metadata));
    out.set("streams", tracks);

    avformat_close_input(&fmt);
    av_freep(&io->buffer);
    avio_context_free(&io);
    return out;
}

class DecodeSession {
public:
    explicit DecodeSession(const val& source)
        : reader_{make_range_reader(source)} {}

    void open() {
        auto* io_buffer = static_cast<std::uint8_t*>(av_malloc(32 * 1024));
        if (!io_buffer) throw std::bad_alloc();
        io_ = avio_alloc_context(io_buffer, 32 * 1024, 0, &reader_, &read_packet, nullptr, &seek);
        if (!io_) {
            av_free(io_buffer);
            throw std::runtime_error("avio_alloc_context failed");
        }

        fmt_ = avformat_alloc_context();
        if (!fmt_) throw std::bad_alloc();
        fmt_->pb = io_;
        fmt_->flags |= AVFMT_FLAG_CUSTOM_IO;

        int ret = avformat_open_input(&fmt_, nullptr, nullptr, nullptr);
        if (ret < 0) throw av_error("avformat_open_input failed", ret);
        ret = avformat_find_stream_info(fmt_, nullptr);
        if (ret < 0) throw av_error("avformat_find_stream_info failed", ret);
        timeline_start_ = timeline_start_time(fmt_);

        decoders_.resize(fmt_->nb_streams);
        open_decoders();
    }

    ~DecodeSession() {
        if (pkt_) av_packet_free(&pkt_);
        for (auto& decoder : decoders_) {
            if (decoder.sws) sws_freeContext(decoder.sws);
            if (decoder.swr) swr_free(&decoder.swr);
            if (decoder.out_layout.nb_channels) av_channel_layout_uninit(&decoder.out_layout);
            if (decoder.ctx) avcodec_free_context(&decoder.ctx);
        }
        if (fmt_) avformat_close_input(&fmt_);
        if (io_) {
            av_freep(&io_->buffer);
            avio_context_free(&io_);
        }
    }

    val info() const {
        val out = val::object();
        out.set("ffmpegVersion", av_version_info());
        out.set("format", fmt_->iformat && fmt_->iformat->name ? fmt_->iformat->name : "");
        out.set("durationSeconds", fmt_->duration != AV_NOPTS_VALUE ? static_cast<double>(fmt_->duration) / AV_TIME_BASE : 0.0);
        out.set("metadata", metadata_to_js(fmt_->metadata));
        out.set("streams", tracks_);
        return out;
    }

    val read() {
        val out = val::object();
        val chunks = val::array();
        out.set("chunks", chunks);
        out.set("done", done_);
        if (done_) return out;

        while (chunks["length"].as<unsigned>() == 0) {
            int ret = av_read_frame(fmt_, pkt_);
            if (ret == AVERROR_EOF) {
                flush(chunks);
                done_ = true;
                break;
            }
            if (ret < 0) throw av_error("av_read_frame failed", ret);
            if (pkt_->stream_index >= 0 && pkt_->stream_index < static_cast<int>(decoders_.size())) {
                auto& decoder = decoders_[static_cast<std::size_t>(pkt_->stream_index)];
                if (decoder.ctx && avcodec_send_packet(decoder.ctx, pkt_) >= 0) {
                    receive(decoder, fmt_->streams[pkt_->stream_index], chunks);
                }
            }
            av_packet_unref(pkt_);
        }
        out.set("done", done_);
        return out;
    }

    void seek_to(double seconds) {
        if (!fmt_) return;
        const auto timestamp = static_cast<std::int64_t>(seconds * AV_TIME_BASE);
        int ret = av_seek_frame(fmt_, -1, timestamp, AVSEEK_FLAG_BACKWARD);
        if (ret < 0) {
            throw av_error("av_seek_frame failed", ret);
        }
        if (pkt_) av_packet_unref(pkt_);
        for (auto& decoder : decoders_) {
            if (decoder.ctx) avcodec_flush_buffers(decoder.ctx);
            decoder.frames = val::array();
            decoder.audio.clear();
        }
        done_ = false;
    }

private:
    void open_decoders() {
        tracks_ = val::array();
        pkt_ = av_packet_alloc();
        if (!pkt_) throw std::bad_alloc();

        for (unsigned i = 0; i < fmt_->nb_streams; ++i) {
            AVStream* stream = fmt_->streams[i];
            const AVCodecParameters* par = stream->codecpar;
            val track = val::object();
            track.set("index", static_cast<int>(i));
            track.set("id", stream->id);
            track.set("type", av_get_media_type_string(par->codec_type) ? av_get_media_type_string(par->codec_type) : "unknown");
            track.set("codec", avcodec_get_name(par->codec_id));
            track.set("metadata", metadata_to_js(stream->metadata));
            if (par->codec_type == AVMEDIA_TYPE_VIDEO) {
                track.set("width", par->width);
                track.set("height", par->height);
            } else if (par->codec_type == AVMEDIA_TYPE_AUDIO) {
                track.set("sampleRate", par->sample_rate);
                track.set("channels", par->ch_layout.nb_channels);
            }

            if (par->codec_type == AVMEDIA_TYPE_VIDEO || par->codec_type == AVMEDIA_TYPE_AUDIO) {
                const AVCodec* codec = find_decoder(par);
                if (codec) {
                    AVCodecContext* ctx = avcodec_alloc_context3(codec);
                    if (!ctx) throw std::bad_alloc();
                    int ret = avcodec_parameters_to_context(ctx, par);
                    if (ret < 0) throw av_error("avcodec_parameters_to_context failed", ret);
                    ctx->get_format = choose_software_format;
                    ret = avcodec_open2(ctx, codec, nullptr);
                    if (ret < 0) {
                        track.set("decodeError", std::string("decoder open failed"));
                        avcodec_free_context(&ctx);
                    } else {
                        decoders_[i].ctx = ctx;
                        track.set("decodable", true);
                    }
                } else {
                    track.set("decodeError", std::string("no decoder in wasm build"));
                }
            }
            tracks_.call<void>("push", track);
        }
    }

    void receive(DecoderState& state, const AVStream* stream, val& chunks) {
        auto* frame = av_frame_alloc();
        if (!frame) throw std::bad_alloc();
        while (true) {
            const int ret = avcodec_receive_frame(state.ctx, frame);
            if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;
            if (ret < 0) {
                av_frame_free(&frame);
                throw av_error("avcodec_receive_frame failed", ret);
            }

            if (state.ctx->codec_type == AVMEDIA_TYPE_VIDEO) {
                chunks.call<void>("push", make_video_chunk(state, frame, stream));
            } else if (state.ctx->codec_type == AVMEDIA_TYPE_AUDIO) {
                chunks.call<void>("push", make_audio_chunk(state, frame, stream));
            }
            av_frame_unref(frame);
        }
        av_frame_free(&frame);
    }

    void flush(val& chunks) {
        for (unsigned i = 0; i < fmt_->nb_streams; ++i) {
            auto& decoder = decoders_[i];
            if (!decoder.ctx) continue;
            avcodec_send_packet(decoder.ctx, nullptr);
            receive(decoder, fmt_->streams[i], chunks);
        }
    }

    val make_video_chunk(DecoderState& state, const AVFrame* frame, const AVStream* stream) {
        if (!state.sws) {
            state.sws = sws_getContext(frame->width, frame->height, static_cast<AVPixelFormat>(frame->format),
                                       frame->width, frame->height, AV_PIX_FMT_RGBA, SWS_BILINEAR,
                                       nullptr, nullptr, nullptr);
            if (!state.sws) throw std::runtime_error("sws_getContext failed");
        }
        std::vector<std::uint8_t> rgba(static_cast<std::size_t>(frame->width) * frame->height * 4);
        std::uint8_t* dst[] = {rgba.data()};
        int linesize[] = {frame->width * 4};
        sws_scale(state.sws, frame->data, frame->linesize, 0, frame->height, dst, linesize);
        val o = val::object();
        o.set("stream", stream->index);
        o.set("type", "video");
        o.set("time", frame_time(frame, stream, timeline_start_));
        o.set("width", frame->width);
        o.set("height", frame->height);
        o.set("rgba", bytes_to_uint8_array(rgba.data(), rgba.size()));
        return o;
    }

    val make_audio_chunk(DecoderState& state, const AVFrame* frame, const AVStream* stream) {
        if (!state.swr) {
            av_channel_layout_default(&state.out_layout, frame->ch_layout.nb_channels > 1 ? 2 : 1);
            int ret = swr_alloc_set_opts2(&state.swr, &state.out_layout, AV_SAMPLE_FMT_FLT, frame->sample_rate,
                                          &frame->ch_layout, static_cast<AVSampleFormat>(frame->format),
                                          frame->sample_rate, 0, nullptr);
            if (ret < 0 || !state.swr) throw av_error("swr_alloc_set_opts2 failed", ret);
            ret = swr_init(state.swr);
            if (ret < 0) throw av_error("swr_init failed", ret);
        }
        const int channels = state.out_layout.nb_channels;
        const int capacity = swr_get_out_samples(state.swr, frame->nb_samples);
        std::vector<float> samples(static_cast<std::size_t>(capacity) * channels);
        std::uint8_t* out[] = {reinterpret_cast<std::uint8_t*>(samples.data())};
        const int got = swr_convert(state.swr, out, capacity, const_cast<const std::uint8_t**>(frame->data), frame->nb_samples);
        if (got < 0) throw av_error("swr_convert failed", got);
        samples.resize(static_cast<std::size_t>(got) * channels);

        val o = val::object();
        o.set("stream", stream->index);
        o.set("type", "audio");
        o.set("time", frame_time(frame, stream, timeline_start_));
        o.set("sampleRate", frame->sample_rate);
        o.set("channels", channels);
        o.set("samples", floats_to_float32_array(samples.data(), samples.size()));
        return o;
    }

    RangeReader reader_;
    AVIOContext* io_ = nullptr;
    AVFormatContext* fmt_ = nullptr;
    AVPacket* pkt_ = nullptr;
    std::vector<DecoderState> decoders_;
    val tracks_ = val::array();
    double timeline_start_ = 0.0;
    bool done_ = false;
};

static std::string version_js() {
    return av_version_info();
}

EMSCRIPTEN_BINDINGS(ffplayer_module) {
    emscripten::function("version", &version_js);
    emscripten::function("decode", &decode_js);
    emscripten::class_<DecodeSession>("DecodeSession")
        .constructor<const val&>()
        .function("open", &DecodeSession::open)
        .function("info", &DecodeSession::info)
        .function("read", &DecodeSession::read)
        .function("seek", &DecodeSession::seek_to);
}
