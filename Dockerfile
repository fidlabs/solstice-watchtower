# Build from the repository root: docker build -t solstice-watchtower-site .
FROM python:3.13-alpine
WORKDIR /app
COPY site/ ./site/
COPY docker/serve-site.py ./serve-site.py
USER nobody
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/index.html', timeout=3)"
CMD ["python3", "serve-site.py"]
