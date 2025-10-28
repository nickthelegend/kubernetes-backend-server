# Deploy Service Usage

## Setup

1. Create registry secret:
```bash
kubectl create secret docker-registry regcred \
  --docker-server=your-registry.com \
  --docker-username=your-username \
  --docker-password=your-password
```

2. Deploy the service:
```bash
kubectl apply -f k8s-manifests.yaml
```

## API Usage

### Deploy an app
```bash
curl -X POST http://deploy-service/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "repo_url": "https://github.com/user/repo.git",
    "image_name": "my-app",
    "registry": "registry.digitalocean.com/my-registry",
    "app_name": "my-app",
    "port": 3000,
    "registry_auth": "regcred"
  }'
```

### Check status
```bash
curl http://deploy-service/status/my-app-1234567890
```

### Get logs
```bash
curl http://deploy-service/logs/my-app-1234567890
```

## Frontend Integration

```javascript
// Deploy button handler
async function deployApp() {
  const response = await fetch('/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo_url: 'https://github.com/user/repo.git',
      image_name: 'my-app',
      registry: 'registry.digitalocean.com/my-registry',
      app_name: 'my-app',
      port: 3000,
      registry_auth: 'regcred'
    })
  });
  
  const { job_id } = await response.json();
  
  // Poll status
  const interval = setInterval(async () => {
    const statusRes = await fetch(`/status/${job_id}`);
    const status = await statusRes.json();
    
    if (status.status === 'completed') {
      clearInterval(interval);
      console.log('Deployment successful!');
    } else if (status.status === 'failed') {
      clearInterval(interval);
      console.log('Deployment failed!');
    }
  }, 5000);
}
```