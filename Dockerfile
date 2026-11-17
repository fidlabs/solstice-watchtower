# Build from the repository root: docker build -t solstice-watchtower-site .
FROM python:3.13-alpine
WORKDIR /app
COPY site/ ./site/
COPY docker/serve-site.py ./serve-site.py
USER nobody
EXPOSE 8000
CMD ["python3", "serve-site.py"]
