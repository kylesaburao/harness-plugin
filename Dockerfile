# syntax=docker/dockerfile:1
# Base images are pinned to their multi-platform index digests; the comment keeps the readable tag.
# node:24-trixie
FROM node:24-trixie@sha256:1278a37eb510ec1606fba0e80f554bcc941ae0b44f35ae373c4822ae7717c64d AS media-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl meson ninja-build nasm pkg-config libx264-dev xxd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
# xxd is required for VMAF's built-in models, even though Meson treats it as optional.
RUN curl -fL https://github.com/Netflix/vmaf/archive/refs/tags/v3.2.0.tar.gz -o vmaf.tar.gz \
    && echo "a28f93f3b4fa65601be324587072e32a6a704a304ba7b1aec9b70b3f709bc1dc  vmaf.tar.gz" | sha256sum -c - \
    && tar -xzf vmaf.tar.gz \
    && meson setup vmaf-3.2.0/libvmaf/build vmaf-3.2.0/libvmaf \
        --prefix=/opt/media --libdir=lib --buildtype=release \
        -Denable_tests=false -Denable_docs=false \
    && ninja -C vmaf-3.2.0/libvmaf/build install

RUN curl -fL https://ffmpeg.org/releases/ffmpeg-8.0.3.tar.xz -o ffmpeg.tar.xz \
    && echo "6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818  ffmpeg.tar.xz" | sha256sum -c - \
    && tar -xf ffmpeg.tar.xz \
    && cd ffmpeg-8.0.3 \
    && PKG_CONFIG_PATH=/opt/media/lib/pkgconfig ./configure \
        --prefix=/opt/media --enable-libvmaf --enable-gpl --enable-libx264 \
        --disable-doc --disable-debug \
    && make -j"$(nproc)" \
    && make install

# rust:1-trixie
FROM rust:1-trixie@sha256:6ff07edce8775d0f64be7aba9197229407301bddf2054d62c27b541a6238a181 AS gifski-builder
RUN cargo install gifski --version 1.34.0 --locked --root /opt/gifski

# node:24-trixie
FROM node:24-trixie@sha256:1278a37eb510ec1606fba0e80f554bcc941ae0b44f35ae373c4822ae7717c64d
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates git python3 python3-venv ripgrep gifsicle libx264-164 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=media-builder /opt/media /opt/media
COPY --from=gifski-builder /opt/gifski/bin/gifski /usr/local/bin/gifski
RUN echo /opt/media/lib > /etc/ld.so.conf.d/media.conf && ldconfig
ENV PATH=/opt/media/bin:$PATH
# Exercise the runtime libraries and built-in model, not just filter discovery.
RUN ffmpeg -v error -f lavfi -i testsrc2=s=64x64:d=0.1 \
    -filter_complex '[0:v]split[a][b];[a][b]libvmaf' -c:v libx264 -f null -
ENV HOME=/home/node
WORKDIR /workspace/harness-plugin
USER node
CMD ["bash"]
