FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep patch && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir pytest==8.3.5 MarkupSafe==3.0.3 ephemeral-port-reserve==1.1.4 pytest-timeout==2.3.1 cryptography==44.0.2 cffi==1.17.1 watchdog==6.0.0
ENV PYTHONPATH=/workspace/src PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /workspace
CMD ["sleep", "infinity"]
