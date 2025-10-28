#!/bin/bash

# Build and push Docker image
docker build -t registry.digitalocean.com/orcanet/deploy-service:latest .
docker push registry.digitalocean.com/orcanet/deploy-service:latest

# Deploy to Kubernetes
kubectl apply -f deploy.yaml

# Wait for deployment
kubectl rollout status deployment/deploy-service

# Get service URL
kubectl get service deploy-service