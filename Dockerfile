FROM node:20-bullseye


# Install FFmpeg (CPU-intensive transcoding)
RUN apt-get update -y \
&& apt-get install -y --no-install-recommends ffmpeg \
&& rm -rf /var/lib/apt/lists/*


WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .


ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]