const express = require('express');
const cors = require('cors');
const k8s = require('@kubernetes/client-node');

const app = express();
app.use(cors());
app.use(express.json());

const kc = new k8s.KubeConfig();
kc.loadFromCluster();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
const k8sNetworkingApi = kc.makeApiClient(k8s.NetworkingV1Api);

const namespace = process.env.NAMESPACE || 'default';

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test endpoint for debugging
app.post('/test', (req, res) => {
  console.log('Test endpoint - Raw body:', req.body);
  res.json({ 
    received: req.body,
    type: typeof req.body,
    keys: Object.keys(req.body || {})
  });
});

// Deploy endpoint - deploys pre-built images from GHCR
app.post('/deploy', async (req, res) => {
  try {
    console.log('Raw request body:', req.body);
    console.log('Request body type:', typeof req.body);
    console.log('Request body keys:', Object.keys(req.body || {}));
    
    const { image_name, app_name, port = 3000, registry_auth = 'ghcr-secret', domain } = req.body || {};
    
    console.log('Extracted values:', { image_name, app_name, port, registry_auth });
    
    if (!image_name || !app_name) {
      console.log('Validation failed - image_name:', !!image_name, 'app_name:', !!app_name);
      return res.status(400).json({ 
        error: 'Missing required fields: image_name, app_name',
        received: { image_name: !!image_name, app_name: !!app_name },
        body: req.body
      });
    }

    const jobId = `${app_name}-${Date.now()}`;
    const appDomain = domain || `${app_name}.0rca.live`;
    
    await createOrUpdateDeployment({ app_name, image_name, port, registry_auth, domain: appDomain });
    
    res.json({ 
      job_id: jobId, 
      status: 'completed',
      domain: appDomain,
      url: `https://${appDomain}`
    });
  } catch (error) {
    console.error('Deploy error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Status endpoint
app.get('/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const appName = jobId.split('-')[0];
    
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
    if (error.response && error.response.statusCode === 404) {
      return res.status(404).json({ error: 'Deployment not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

async function createOrUpdateDeployment({ app_name, image_name, port, registry_auth, domain }) {
  // Create deployment
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: app_name, namespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: app_name } },
      template: {
        metadata: { labels: { app: app_name } },
        spec: {
          containers: [{
            name: app_name,
            image: image_name, // Use full GHCR image path
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
    if (error.response && error.response.statusCode === 404) {
      await k8sAppsApi.createNamespacedDeployment(namespace, deployment);
    } else {
      throw error;
    }
  }
  
  // Create service
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: app_name, namespace },
    spec: {
      selector: { app: app_name },
      ports: [{ port: 80, targetPort: port }],
      type: 'ClusterIP'
    }
  };
  
  try {
    await k8sApi.replaceNamespacedService(app_name, namespace, service);
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      await k8sApi.createNamespacedService(namespace, service);
    } else {
      throw error;
    }
  }
  
  // Create ingress with subdomain and SSL
  const ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: `${app_name}-ingress`,
      namespace,
      annotations: {
        'nginx.ingress.kubernetes.io/rewrite-target': '/',
        'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
        'nginx.ingress.kubernetes.io/ssl-redirect': 'true'
      }
    },
    spec: {
      ingressClassName: 'nginx',
      tls: [{
        hosts: [domain],
        secretName: `${app_name}-tls`
      }],
      rules: [{
        host: domain,
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: { service: { name: app_name, port: { number: 80 } } }
          }]
        }
      }]
    }
  };
  
  try {
    await k8sNetworkingApi.replaceNamespacedIngress(`${app_name}-ingress`, namespace, ingress);
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      await k8sNetworkingApi.createNamespacedIngress(namespace, ingress);
    } else {
      throw error;
    }
  }
}

app.listen(8080, () => console.log('Deploy service running on port 8080'));