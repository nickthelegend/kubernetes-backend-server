# Deploy Service

Backend service for automated Docker builds and Kubernetes deployments.

## Setup

1. **Create GitHub repo** and push this code
2. **Push to main branch** - GitHub Actions will build and push Docker image to ghcr.io
3. **Deploy manually** using the generated image:
   ```bash
   # Create GitHub registry secret
   kubectl create secret docker-registry ghcr-secret \
     --docker-server=ghcr.io \
     --docker-username=YOUR_GITHUB_USERNAME \
     --docker-password=YOUR_GITHUB_TOKEN
   
   # Update k8s-github-deploy.yaml with your GitHub username
   # Then deploy
   kubectl apply -f k8s-github-deploy.yaml
   ```

## GitHub Actions

Push to `main` branch triggers:
- Docker build
- Push to GitHub Container Registry (ghcr.io)

## API Usage

```bash
# Deploy an app
curl -X POST http://YOUR_SERVICE_IP/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "repo_url": "https://github.com/user/repo.git",
    "image_name": "my-app",
    "app_name": "my-app",
    "port": 3000
  }'
```