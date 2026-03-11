# Teros - Docker Setup

Complete Docker configuration for running Teros with all services.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Docker Network                    │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐   │
│  │   Frontend   │  │   Backend    │  │ MongoDB  │   │
│  │   (nginx)    │  │  (Node.js)   │  │  (7.0)   │   │
│  │              │  │              │  │          │   │
│  │  Port: 8080  │  │  Port: 3001  │  │Port:27017│   │
│  └──────────────┘  └──────────────┘  └──────────┘   │
│         │                  │                │       │
│         └──────────────────┴────────────────┘       │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Services

### 1. MongoDB (`mongodb`)
- **Image**: `mongo:7.0`
- **Port**: `27017`
- **Volumes**: 
  - `mongodb_data:/data/db`
  - `mongodb_config:/data/configdb`
- **Health Check**: MongoDB ping command

### 2. Backend (`backend`)
- **Build**: `packages/backend/Dockerfile`
- **Port**: `3001`
- **Endpoints**:
  - WebSocket: `ws://localhost:3001/ws`
  - Health: `http://localhost:3001/health`
- **Depends on**: MongoDB (waits for healthy)

### 3. Frontend (`frontend`)
- **Build**: `packages/app/Dockerfile`
- **Port**: `8080`
- **Server**: Nginx
- **URL**: `http://localhost:8080`
- **Endpoints**:
  - App: `http://localhost:8080/`
  - Health: `http://localhost:8080/health`
- **Depends on**: Backend

## Quick Start

### 1. Initial Setup

```bash
# Clone or navigate to project
cd workspace/teros

# Copy environment template
cp .env.example .env

# Generate session secret
openssl rand -base64 32

# Edit .env and set SESSION_TOKEN_SECRET
nano .env
```

### 2. Start All Services

```bash
# Build and start all containers
docker compose up -d

# View logs
docker compose logs -f

# View specific service logs
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f mongodb
```

### 3. Verify Services

```bash
# Check all services are running
docker compose ps

# Check backend health
curl http://localhost:3001/health

# Check frontend health
curl http://localhost:8080/health

# Check MongoDB
docker compose exec mongodb mongosh --eval "db.adminCommand('ping')"
```

### 4. Access the App

Open your browser:
- **Frontend**: http://localhost:8080
- **Backend WebSocket**: ws://localhost:3001/ws
- **Backend Health**: http://localhost:3001/health

## Environment Variables

Create `.env` file in project root:

```bash
# Required
SESSION_TOKEN_SECRET=your-generated-secret-here

# Optional (has defaults)
BACKEND_PORT=3001
FRONTEND_PORT=8080
MONGODB_URI=mongodb://mongodb:27017
MONGODB_DATABASE=teros
```

## Commands

### Start/Stop

```bash
# Start all services
docker compose up -d

# Stop all services
docker compose down

# Stop and remove volumes (⚠️ deletes database)
docker compose down -v

# Restart specific service
docker compose restart backend
docker compose restart frontend
docker compose restart mongodb
```

### Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend

# Last 100 lines
docker compose logs --tail=100 backend

# Since 10 minutes ago
docker compose logs --since 10m backend
```

### Rebuild

```bash
# Rebuild all services
docker compose build

# Rebuild specific service
docker compose build backend
docker compose build frontend

# Rebuild and restart
docker compose up -d --build

# Rebuild without cache
docker compose build --no-cache
```

### Database

```bash
# Access MongoDB shell
docker compose exec mongodb mongosh teros

# List databases
docker compose exec mongodb mongosh --eval "show dbs"

# List collections
docker compose exec mongodb mongosh teros --eval "db.getCollectionNames()"

# Count users
docker compose exec mongodb mongosh teros --eval "db.users.countDocuments()"

# Backup database
docker compose exec mongodb mongosh teros --eval "db.adminCommand('backup')" > backup.json

# Restore from backup
docker compose exec -T mongodb mongosh teros < backup.json
```

### Debugging

```bash
# Enter backend container
docker compose exec backend sh

# Enter frontend container
docker compose exec frontend sh

# Enter MongoDB container
docker compose exec mongodb bash

# Check network
docker network inspect teros_teros-network

# View resource usage
docker compose stats
```

## Health Checks

All services have health checks:

```bash
# Check health status
docker compose ps

# Healthy services show: (healthy)
# Unhealthy services show: (unhealthy)
# Starting services show: (health: starting)
```

### Manual Health Checks

```bash
# MongoDB
docker compose exec mongodb mongosh --eval "db.adminCommand('ping')"

# Backend
curl http://localhost:3001/health
# Response: {"status":"ok","timestamp":"...","connections":0}

# Frontend
curl http://localhost:8080/health
# Response: OK
```

## Development Workflow

### 1. Code Changes

```bash
# After changing backend code
docker compose restart backend

# After changing frontend code
docker compose up -d --build frontend

# After changing both
docker compose up -d --build
```

### 2. Database Reset

```bash
# Stop all services
docker compose down

# Remove volumes (⚠️ deletes all data)
docker compose down -v

# Start fresh
docker compose up -d
```

### 3. View Real-time Logs

```bash
# All services in separate terminals
docker compose logs -f backend &
docker compose logs -f frontend &
docker compose logs -f mongodb &

# Or use docker compose logs -f for all
```

## Production Deployment

### 1. Update Environment

```bash
# Production .env
SESSION_TOKEN_SECRET=<strong-random-secret>
NODE_ENV=production
MONGODB_URI=mongodb://mongodb:27017
```

### 2. Build for Production

```bash
# Build optimized images
docker compose build --no-cache

# Start with production config
docker compose -f docker compose.yml up -d
```

### 3. Enable HTTPS (Recommended)

Add nginx reverse proxy or use Traefik:

```yaml
# docker compose.prod.yml (example)
services:
  frontend:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.teros.rule=Host(`teros.yourdomain.com`)"
      - "traefik.http.routers.teros.tls=true"
      - "traefik.http.routers.teros.tls.certresolver=letsencrypt"
```

## Troubleshooting

### Services Won't Start

```bash
# Check logs
docker compose logs

# Check specific service
docker compose logs backend

# Rebuild
docker compose up -d --build --force-recreate
```

### MongoDB Connection Issues

```bash
# Verify MongoDB is healthy
docker compose ps mongodb

# Check MongoDB logs
docker compose logs mongodb

# Test connection
docker compose exec backend sh
> nc -zv mongodb 27017
```

### Frontend Can't Connect to Backend

```bash
# Check backend is running
curl http://localhost:3001/health

# Check frontend nginx config
docker compose exec frontend cat /etc/nginx/conf.d/default.conf

# Restart frontend
docker compose restart frontend
```

### Port Already in Use

```bash
# Find process using port
lsof -i :3001
lsof -i :8080

# Change port in docker compose.yml
ports:
  - "3002:3001"  # Use different host port
```

### Out of Disk Space

```bash
# Remove unused images
docker image prune -a

# Remove unused volumes
docker volume prune

# Remove everything (⚠️ careful)
docker system prune -a --volumes
```

## File Structure

```
teros/
├── docker compose.yml              # Main compose file
├── .env                            # Environment variables (git-ignored)
├── .env.example                    # Environment template
├── .dockerignore                   # Docker build ignore
├── DOCKER.md                       # This file
├── packages/
│   ├── backend/
│   │   ├── Dockerfile              # Backend image
│   │   ├── .env                    # Backend env (for local dev)
│   │   └── src/
│   └── app/
│       ├── Dockerfile              # Frontend image
│       ├── nginx.conf              # Nginx configuration
│       └── src/
└── volumes/                        # Created by docker compose
    ├── mongodb_data/
    └── mongodb_config/
```

## Next Steps

1. **Start services**: `docker compose up -d`
2. **Check logs**: `docker compose logs -f`
3. **Open app**: http://localhost:8080
4. **Test WebSocket**: Connect to ws://localhost:3001/ws
5. **Login**: Use the credentials you created with `bun run seed` or `create-user` script

## Support

- **Backend errors**: Check `docker compose logs backend`
- **Frontend issues**: Check `docker compose logs frontend`
- **Database problems**: Check `docker compose logs mongodb`
- **Network issues**: Check `docker network inspect teros_teros-network`

---

**Ready to go!** Run `docker compose up -d` to start Teros 🚀
