# Dockerfile
FROM node:20-alpine

# (opsional) tambahkan utilitas untuk healthcheck
RUN apk add --no-cache git wget nano

WORKDIR /usr/src/app


# buat package.json default
RUN npm init -y

# install paket yang dipakai di index.mjs
RUN npm install express cors @whiskeysockets/baileys qrcode

# Salin manifest dulu agar cache build efisien

COPY index.mjs ./index.mjs
# (opsional) salin folder public kalau ada UI
COPY public ./public


# Env default
ENV NODE_ENV=production
ENV PORT=3000
# AUTH_ROOT di-override di compose agar ke volume
ENV AUTH_ROOT=/usr/src/app/auth_info

EXPOSE 3000

# Healthcheck sederhana ke endpoint /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health | grep -q '"ok":true' || exit 1

CMD ["node", "index.mjs"]
