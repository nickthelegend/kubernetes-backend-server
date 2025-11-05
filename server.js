const express = require('express');
const cors = require('cors');
const k8s = require('@kubernetes/client-node');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const kc = new k8s.KubeConfig();
kc.loadFromCluster();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api);
const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
const k8sNetworkingApi = kc.makeApiClient(k8s.NetworkingV1Api);

const namespace = process.env.NAMESPACE || 'default';

// Deploy endpoint
app.post('/deploy', async (req, res) => {
  try {
    const { 
      image_name, // Full image path like 'ghcr.io/user/repo:tag'
      app_name, 
      port = 3000, 
      registry_auth = 'regcred',
      domain // Optional custom domain, defaults to {app_name}.0rca.live
    } = req.body;
    
    if (!image_name || !app_name) {
      return res.status(400).json({ error: 'Missing required fields: image_name, app_name' });
    }

    const jobId = `${app_name}-${Date.now()}`;
    const appDomain = domain || `${app_name}.0rca.live`;
    
    // Broadcast start event
    broadcastLog(jobId, 'info', `Starting deployment for ${app_name}`);
    broadcastLog(jobId, 'info', `Image: ${image_name}`);
    broadcastLog(jobId, 'info', `Domain: ${appDomain}`);
    
    // Create deployment directly (no build needed)
    await createOrUpdateDeployment({ app_name, image_name, port, registry_auth, domain: appDomain });
    broadcastLog(jobId, 'success', `Deployment created! App will be available at: http://${appDomain}`);
    
    res.json({ 
      job_id: jobId, 
      status: 'completed',
      domain: appDomain,
      url: `http://${appDomain}`
    });
  } catch (error) {
    console.error('Deploy error:', error);
    broadcastLog('error', 'error', `Deploy failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Status endpoint
app.get('/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const appName = jobId.split('-')[0]; // Extract app name from job ID
    
    // Check deployment status instead of build job
    const deploymentResponse = await k8sAppsApi.readNamespacedDeployment(appName, namespace);
    const deployment = deploymentResponse.body;
    
    let status = 'running';
    let phase = 'deploying';
    let message = 'Deployment in progress';
    
    if (deployment.status.readyReplicas > 0) {
      status = 'completed';
      phase = 'deployed';
      message = 'Deployment successful';
    } else if (deployment.status.replicas === 0) {
      status = 'failed';
      phase = 'failed';
      message = 'Deployment failed';
    }
    
    res.json({
      job_id: jobId,
      status,
      phase,
      message,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.response?.statusCode === 404) {
      return res.status(404).json({ error: 'Deployment not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Logs endpoint
app.get('/logs/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    // Find pod for the job
    const podsResponse = await k8sApi.listNamespacedPod(
      namespace,
      undefined, undefined, undefined, undefined,
      `job-name=${jobId}`
    );
    
    if (podsResponse.body.items.length === 0) {
      return res.status(404).json({ error: 'Pod not found' });
    }
    
    const podName = podsResponse.body.items[0].metadata.name;
    
    // Stream logs
    const logStream = await k8sApi.readNamespacedPodLog(
      podName,
      namespace,
      undefined, // container
      true, // follow
      undefined, // previous
      undefined, // sinceSeconds
      undefined, // sinceTime
      undefined, // tailLines
      undefined, // timestamps
      { headers: { 'Accept': 'text/plain' } }
    );
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    
    logStream.pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Build job function removed - we now deploy pre-built images directly

async function createOrUpdateDeployment({ app_name, image_name, port, registry_auth, domain }) {
  const imageName = image_name; // Use full image path as provided
  
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: app_name,
      namespace
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: { app: app_name }
      },
      template: {
        metadata: {
          labels: { app: app_name }
        },
        spec: {
          containers: [{
            name: app_name,
            image: imageName,
            ports: [{ containerPort: port }]
          }],
          imagePullSecrets: [{ name: registry_auth }]
        }
      }
    }
  };
  
  try {
    await k8sAppsApi.replaceNamespacedDeployment(app_name, namespace, deployment);
  } catch (error) {
    if (error.response?.statusCode === 404) {
      await k8sAppsApi.createNamespacedDeployment(namespace, deployment);
    } else {
      throw error;
    }
  }
  
  // Create service
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: app_name,
      namespace
    },
    spec: {
      selector: { app: app_name },
      ports: [{
        port: 80,
        targetPort: port
      }],
      type: 'ClusterIP'
    }
  };
  
  try {
    await k8sApi.replaceNamespacedService(app_name, namespace, service);
  } catch (error) {
    if (error.response?.statusCode === 404) {
      await k8sApi.createNamespacedService(namespace, service);
    } else {
      throw error;
    }
  }
  
  // Create ingress
  const ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: `${app_name}-ingress`,
      namespace,
      annotations: {
        'nginx.ingress.kubernetes.io/rewrite-target': '/'
      }
    },
    spec: {
      ingressClassName: 'nginx',
      rules: [{
        host: domain,
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: {
              service: {
                name: app_name,
                port: { number: 80 }
              }
            }
          }]
        }
      }]
    }
  };
  
  try {
    await k8sNetworkingApi.replaceNamespacedIngress(`${app_name}-ingress`, namespace, ingress);
  } catch (error) {
    if (error.response?.statusCode === 404) {
      await k8sNetworkingApi.createNamespacedIngress(namespace, ingress);
    } else {
      throw error;
    }
  }
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('Client connected to WebSocket');
  ws.subscribedJobs = new Set();
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.action === 'subscribe' && data.job_id) {
        ws.subscribedJobs.add(data.job_id);
        console.log(`Client subscribed to job: ${data.job_id}`);
      } else if (data.action === 'unsubscribe' && data.job_id) {
        ws.subscribedJobs.delete(data.job_id);
        console.log(`Client unsubscribed from job: ${data.job_id}`);
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
  
  ws.on('close', () => console.log('Client disconnected'));
});

// Broadcast logs to subscribed clients only
function broadcastLog(jobId, level, message) {
  const logData = {
    job_id: jobId,
    level,
    message,
    timestamp: new Date().toISOString()
  };
  
  console.log(`[${level.toUpperCase()}] ${jobId}: ${message}`);
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.subscribedJobs.has(jobId)) {
      client.send(JSON.stringify(logData));
    }
  });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Deploy service running on port ${PORT}`);
  console.log(`WebSocket server ready for real-time logs`);
});