FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.py .
COPY flow ./flow
COPY web ./web
EXPOSE 28888
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "28888", "--root", "/media", "--data", "/data"]
