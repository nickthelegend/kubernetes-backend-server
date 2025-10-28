const express = require('express');
const cors = require('cors');
const k8s = require('@kubernetes/client-node');

const app = express();
app.use(cors());
app.use(express.json());

const kc = new k8s.KubeConfig();
kc.loadFromCluster();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api);
const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);

const namespace = process.env.NAMESPACE || 'default';

// Deploy endpoint
app.post('/deploy', async (req, res) => {
  try {
    const { 
      repo_url, 
      image_name, 
      registry = 'registry.digitalocean.com/orcanet', 
      app_name, 
      port = 3000, 
      registry_auth = 'regcred' 
    } = req.body;
    
    if (!repo_url || !image_name || !app_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const jobId = `${app_name}-${Date.now()}`;
    
    // Create BuildKit build job
    await createBuildKitJob(jobId, { repo_url, image_name, registry, registry_auth });
    
    // Create or update deployment
    await createOrUpdateDeployment({ app_name, image_name, registry, port, registry_auth });
    
    res.json({ job_id: jobId, status: 'started' });
  } catch (error) {
    console.error('Deploy error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Status endpoint
app.get('/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    const jobResponse = await k8sBatchApi.readNamespacedJob(jobId, namespace);
    const job = jobResponse.body;
    
    let status = 'running';
    let phase = 'building';
    let message = 'Build in progress';
    
    if (job.status.succeeded > 0) {
      status = 'completed';
      phase = 'deployed';
      message = 'Build and deployment successful';
    } else if (job.status.failed > 0) {
      status = 'failed';
      phase = 'failed';
      message = 'Build failed';
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
      return res.status(404).json({ error: 'Job not found' });
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

async function createBuildKitJob(jobId, { repo_url, image_name, registry, registry_auth }) {
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobId,
      namespace
    },
    spec: {
      template: {
        spec: {
          restartPolicy: 'Never',
          initContainers: [{
            name: 'git-clone',
            image: 'alpine/git:latest',
            command: ['git', 'clone', repo_url, '/workspace'],
            volumeMounts: [{
              name: 'workspace',
              mountPath: '/workspace'
            }]
          }],
          containers: [{
            name: 'buildctl',
            image: 'moby/buildkit:latest',
            command: ['buildctl'],
            args: [
              '--addr', 'tcp://buildkitd:1234',
              'build',
              '--frontend', 'dockerfile.v0',
              '--local', 'context=/workspace',
              '--local', 'dockerfile=/workspace',
              '--output', `type=image,name=${registry}/${image_name}:latest,push=true`
            ],
            volumeMounts: [{
              name: 'workspace',
              mountPath: '/workspace'
            }, {
              name: 'docker-config',
              mountPath: '/root/.docker'
            }]
          }],
          volumes: [{
            name: 'workspace',
            emptyDir: {}
          }, {
            name: 'docker-config',
            secret: {
              secretName: registry_auth,
              items: [{
                key: '.dockerconfigjson',
                path: 'config.json'
              }]
            }
          }]
        }
      }
    }
  };
  
  await k8sBatchApi.createNamespacedJob(namespace, job);
}

async function createOrUpdateDeployment({ app_name, image_name, registry, port, registry_auth }) {
  const imageName = `${registry}/${image_name}:latest`;
  
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
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Deploy service running on port ${PORT}`);
});