# syntax=docker/dockerfile:1
FROM node:26-trixie AS media-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl meson ninja-build nasm pkg-config libx264-dev xxd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
# xxd is required for VMAF's built-in models, even though Meson treats it as optional.
RUN curl -fL https://github.com/Netflix/vmaf/archive/refs/tags/v3.2.0.tar.gz -o vmaf.tar.gz \
    && tar -xzf vmaf.tar.gz \
    && meson setup vmaf-3.2.0/libvmaf/build vmaf-3.2.0/libvmaf \
        --prefix=/opt/media --libdir=lib --buildtype=release \
        -Denable_tests=false -Denable_docs=false \
    && ninja -C vmaf-3.2.0/libvmaf/build install

RUN curl -fL https://ffmpeg.org/releases/ffmpeg-8.0.3.tar.xz -o ffmpeg.tar.xz \
    && tar -xf ffmpeg.tar.xz \
    && cd ffmpeg-8.0.3 \
    && PKG_CONFIG_PATH=/opt/media/lib/pkgconfig ./configure \
        --prefix=/opt/media --enable-libvmaf --enable-gpl --enable-libx264 \
        --disable-doc --disable-debug \
    && make -j"$(nproc)" \
    && make install

FROM rust:1-trixie AS gifski-builder
RUN cargo install gifski --version 1.34.0 --locked --root /opt/gifski

FROM node:26-trixie
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
