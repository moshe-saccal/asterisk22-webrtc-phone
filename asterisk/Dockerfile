# syntax=docker/dockerfile:1
#
# Asterisk 22 (LTS) built from source with the bundled PJSIP stack and
# everything required for WebRTC: DTLS-SRTP (libsrtp2), ICE, Opus, VP8/H.264
# passthrough and the HTTP/WebSocket transport.
#
ARG DEBIAN_RELEASE=trixie

############################  build stage  ####################################
FROM debian:${DEBIAN_RELEASE}-slim AS build

ARG ASTERISK_VERSION=22.11.0
ARG ASTERISK_SHA256=3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      autoconf automake binutils build-essential bzip2 ca-certificates curl file \
      libcurl4-openssl-dev libedit-dev libgsm1-dev libjansson-dev libncurses-dev \
      libogg-dev libopus-dev libopusfile-dev libpopt-dev libspeex-dev \
      libspeexdsp-dev libsqlite3-dev libsrtp2-dev libssl-dev libvorbis-dev \
      libxml2-dev libxslt1-dev patch pkg-config python3 uuid-dev wget \
      xmlstarlet zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/asterisk

RUN curl -fsSL -o /tmp/asterisk.tar.gz \
      "https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VERSION}.tar.gz" \
 && echo "${ASTERISK_SHA256}  /tmp/asterisk.tar.gz" | sha256sum -c - \
 && tar xzf /tmp/asterisk.tar.gz --strip-components=1 \
 && rm /tmp/asterisk.tar.gz

RUN ./configure \
      --libdir=/usr/lib \
      --with-pjproject-bundled \
      --with-srtp \
      --with-ssl \
      --with-opus \
 && make menuselect.makeopts \
 && menuselect/menuselect \
      --disable BUILD_NATIVE \
      --enable codec_opus \
      --disable CORE-SOUNDS-EN-GSM \
      --enable CORE-SOUNDS-EN-ULAW \
      --enable CORE-SOUNDS-EN-G722 \
      --disable MOH-OPSOUND-WAV \
      --enable MOH-OPSOUND-ULAW \
      --enable MOH-OPSOUND-G722 \
      --enable EXTRA-SOUNDS-EN-ULAW \
      --enable EXTRA-SOUNDS-EN-G722 \
      --disable chan_unistim \
      --disable chan_iax2 \
      --disable pbx_dundi \
      --disable res_pjsip_phoneprov_provider \
      --disable res_phoneprov \
      menuselect.makeopts

# The bundled pjproject sub-build is not parallel-safe: build it serially first.
RUN make third-party \
 && make -j"$(nproc)" \
 && make install DESTDIR=/staging \
 && find /staging/usr/lib/asterisk/modules -name '*.so' -exec strip --strip-unneeded {} + \
 && strip --strip-unneeded /staging/usr/sbin/asterisk /staging/usr/lib/libasterisk*.so.* \
 && rm -rf /staging/etc/asterisk/* /staging/usr/include /staging/var/run \
 && for mod in res_srtp res_http_websocket res_pjsip_transport_websocket res_rtp_asterisk \
               res_format_attr_opus res_format_attr_vp8 res_format_attr_h264 codec_opus \
               chan_pjsip app_confbridge; do \
      test -f "/staging/usr/lib/asterisk/modules/${mod}.so" \
        || { echo "ERROR: required module ${mod} was not built" >&2; exit 1; }; \
    done

# Work out which Debian packages provide the shared libraries we link against,
# so the runtime image installs exactly those (and nothing else).
RUN set -eu; \
    export LD_LIBRARY_PATH=/staging/usr/lib; \
    find /staging -type f \( -name '*.so' -o -name '*.so.*' -o -path '*/sbin/*' \) \
      -exec ldd {} + 2>/dev/null \
      | awk '/=> \// { print $3 }' | sort -u \
      | while read -r lib; do \
          real="$(readlink -f "$lib")"; \
          dpkg -S "$real" 2>/dev/null || dpkg -S "${real#/usr}" 2>/dev/null || true; \
        done \
      | cut -d: -f1 | sort -u > /runtime-packages.txt; \
    echo "Runtime packages:"; cat /runtime-packages.txt

############################  runtime stage  ##################################
FROM debian:${DEBIAN_RELEASE}-slim

ARG DEBIAN_FRONTEND=noninteractive
LABEL org.opencontainers.image.title="asterisk-22-webrtc" \
      org.opencontainers.image.description="Asterisk 22 LTS with PJSIP + WebRTC (WSS, DTLS-SRTP, ICE, Opus, VP8/H.264)"

COPY --from=build /runtime-packages.txt /tmp/runtime-packages.txt
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      $(cat /tmp/runtime-packages.txt) ca-certificates iproute2 jq openssl tini \
 && rm -rf /var/lib/apt/lists/* /tmp/runtime-packages.txt \
 && groupadd --system asterisk \
 && useradd --system --gid asterisk --home-dir /var/lib/asterisk --shell /usr/sbin/nologin asterisk

COPY --from=build /staging/ /
COPY config/ /etc/asterisk/
COPY bin/ /usr/local/bin/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod 0755 /usr/local/bin/* \
 && mkdir -p /var/lib/asterisk/generated /var/lib/asterisk/keys /var/run/asterisk \
             /var/log/asterisk /var/spool/asterisk \
 && chown -R asterisk:asterisk /var/lib/asterisk /var/run/asterisk /var/log/asterisk /var/spool/asterisk \
 && ldconfig \
 && missing="$(find /usr/sbin/asterisk /usr/lib/asterisk/modules -type f -name '*.so' -o -type f -name asterisk \
               | xargs ldd 2>/dev/null | grep 'not found' | sort -u)" \
 && if [ -n "$missing" ]; then echo "Unresolved libraries:\n$missing" >&2; exit 1; fi \
 && asterisk -V

# SIP (UDP/TCP), SIP-TLS, HTTP/WS, HTTPS/WSS. RTP range is published by compose.
EXPOSE 5060/udp 5060/tcp 5061/tcp 8088/tcp 8089/tcp

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD asterisk -rx "core show uptime" | grep -q "System uptime" || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["asterisk", "-f", "-U", "asterisk", "-G", "asterisk", "-vvv"]
