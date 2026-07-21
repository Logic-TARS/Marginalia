FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 8720

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8720"]
