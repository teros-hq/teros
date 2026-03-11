# MinIO Credentials

This MCA requires the following environment variables:

## Required

- `MINIO_ACCESS_KEY` - MinIO access key (username)
- `MINIO_SECRET_KEY` - MinIO secret key (password)

## Optional

- `MINIO_ENDPOINT` - MinIO server hostname (default: `localhost`)
- `MINIO_PORT` - MinIO server port (default: `9000`)
- `MINIO_USE_SSL` - Use HTTPS (default: `false`, set to `true` for SSL)

## Example Configuration

```bash
export MINIO_ENDPOINT="minio.example.com"
export MINIO_PORT="9000"
export MINIO_USE_SSL="true"
export MINIO_ACCESS_KEY="your-access-key"
export MINIO_SECRET_KEY="your-secret-key"
```

## Getting Credentials

1. **Self-hosted MinIO**: Use the credentials you set when deploying MinIO
2. **MinIO Console**: Go to Settings > Access Keys to create new keys
3. **Default credentials**: For fresh installs, default is `minioadmin:minioadmin`

## Security Notes

- Never commit credentials to version control
- Use strong, unique access keys in production
- Consider using IAM policies to limit access scope
