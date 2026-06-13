import * as faceapi from 'face-api.js';

/**
 * Singleton para cargar modelos de face-api.js una única vez
 * Evita race conditions y duplicación de requests
 */
let biometricModelsPromise = null;

const ensureBiometricModelsLoaded = async () => {
  if (!biometricModelsPromise) {
    biometricModelsPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
      faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/models')
    ]);
  }

  await biometricModelsPromise;
};

export { ensureBiometricModelsLoaded };
