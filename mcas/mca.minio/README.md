# MinIO MCA

S3-compatible object storage integration for MinIO.

## Features

- **Bucket Management**: Create, delete, list, and check buckets
- **Object Operations**: Upload, download, copy, delete objects
- **Presigned URLs**: Generate temporary access URLs for sharing
- **Metadata**: Get object info and stats

## Tools

| Tool | Description |
|------|-------------|
| `minio_list_buckets` | List all buckets |
| `minio_create_bucket` | Create a new bucket |
| `minio_delete_bucket` | Delete an empty bucket |
| `minio_bucket_exists` | Check if bucket exists |
| `minio_list_objects` | List objects in a bucket |
| `minio_upload_object` | Upload file or content |
| `minio_download_object` | Download object to local file |
| `minio_delete_object` | Delete an object |
| `minio_copy_object` | Copy object within/between buckets |
| `minio_get_presigned_url` | Generate temporary access URL |
| `minio_get_object_info` | Get object metadata |

## Configuration

Set these environment variables:

```bash
MINIO_ENDPOINT=localhost      # MinIO server hostname
MINIO_PORT=9000               # MinIO server port
MINIO_USE_SSL=false           # Use HTTPS
MINIO_ACCESS_KEY=your-key     # Access key (required)
MINIO_SECRET_KEY=your-secret  # Secret key (required)
```

## Usage Examples

### List all buckets
```
minio_list_buckets
```

### Upload a file
```
minio_upload_object bucket=my-bucket objectName=docs/report.pdf filePath=/path/to/report.pdf
```

### Upload text content
```
minio_upload_object bucket=my-bucket objectName=config.json content='{"key": "value"}'
```

### Generate shareable link (1 hour)
```
minio_get_presigned_url bucket=my-bucket objectName=docs/report.pdf expiry=3600
```

### List objects with prefix
```
minio_list_objects bucket=my-bucket prefix=docs/ recursive=true
```

## Installation

```bash
cd mcp
bun install
```

## License

MIT
