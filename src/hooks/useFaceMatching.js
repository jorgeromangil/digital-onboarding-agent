import { useCallback, useState } from 'react';
import * as faceapi from 'face-api.js';
import { ensureBiometricModelsLoaded } from '../utils/modelLoader';

const FACE_MATCH_THRESHOLD = 0.56;

const FACE_DESCRIPTOR_DETECTOR_OPTIONS = [
  new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.25 }),
  new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 }),
  new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.35 })
];

const getBoxArea = (box) => {
  if (!box) return 0;
  return Math.max(box.width, 0) * Math.max(box.height, 0);
};

/**
 * Hook personalizado para validación biométrica de rostro
 * Encapsula toda la lógica de face matching
 */
export const useFaceMatching = () => {
  const [validationResult, setValidationResult] = useState('IDLE');
  const [isValidatingMatch, setIsValidatingMatch] = useState(false);
  const [agentMatchingMessage, setAgentMatchingMessage] = useState('');
  const [captureFailure, setCaptureFailure] = useState(null); // null=idle, true=fallo técnico, false=ataque/mismatch

  const getFaceDescriptorFromDataUrl = useCallback(async (imageDataUrl, options = {}) => {
    if (!imageDataUrl) return null;

    const { preferSmallFace = false } = options;

    const image = await faceapi.fetchImage(imageDataUrl);
    for (let i = 0; i < FACE_DESCRIPTOR_DETECTOR_OPTIONS.length; i += 1) {
      const detectorOptions = FACE_DESCRIPTOR_DETECTOR_OPTIONS[i];
      const detections = await faceapi
        .detectAllFaces(image, detectorOptions)
        .withFaceLandmarks()
        .withFaceDescriptors();

      if (!detections.length) continue;

      const selectedDetection = detections.reduce((best, current) => {
        if (!best) return current;
        const currentArea = getBoxArea(current.detection?.box);
        const bestArea = getBoxArea(best.detection?.box);
        return preferSmallFace
          ? (currentArea < bestArea ? current : best)
          : (currentArea > bestArea ? current : best);
      }, null);

      if (selectedDetection?.descriptor) {
        return selectedDetection.descriptor;
      }
    }

    return null;
  }, []);

  const runFaceMatch = useCallback(async (capturedImages, onSpeak, matchingMessages) => {
    setValidationResult('PROCESSING');
    setCaptureFailure(null); // Reset al iniciar
    try {
      await ensureBiometricModelsLoaded();

      // CASO 1: Imágenes faltantes (no es fallo de captura, es problema previo)
      if (!capturedImages.DOCUMENT) {
        const msg = matchingMessages?.missingDocument || {};
        const text = msg.text || 'Necesito la captura del DNI frontal para poder validar tu identidad. Completa primero ese paso.';
        const voice = msg.voice || 'Necesito la captura del DNI frontal para validar tu identidad.';
        setAgentMatchingMessage(text);
        onSpeak?.(voice);
        setValidationResult('FAILED');
        setCaptureFailure(true); // Considerar como fallo técnico
        return;
      }
      if (!capturedImages.FACE) {
        const msg = matchingMessages?.missingFace || {};
        const text = msg.text || 'Necesito la captura de tu rostro para poder validar tu identidad. Completa primero ese paso.';
        const voice = msg.voice || 'Necesito la captura de tu rostro para validar tu identidad.';
        setAgentMatchingMessage(text);
        onSpeak?.(voice);
        setValidationResult('FAILED');
        setCaptureFailure(true); // Considerar como fallo técnico
        return;
      }

      const [documentDescriptor, liveDescriptor] = await Promise.all([
        getFaceDescriptorFromDataUrl(capturedImages.DOCUMENT, { preferSmallFace: true }),
        getFaceDescriptorFromDataUrl(capturedImages.FACE, { preferSmallFace: false })
      ]);

      // CASO 2: Fallo técnico - No se detectó rostro en DNI
      if (!documentDescriptor) {
        setValidationResult('FAILED');
        setCaptureFailure(true); // ✓ FALLO TÉCNICO: imagen con baja calidad/sin rostro
        const msg = matchingMessages?.badDocumentQuality || {};
        const text = msg.text || 'No detecté claramente la foto facial del DNI frontal. La imagen tiene baja calidad. Repite la captura frontal para continuar.';
        const voice = msg.voice || 'No detecté claramente la foto facial del DNI frontal. Repite la captura frontal.';
        setAgentMatchingMessage(text);
        onSpeak?.(voice);
        return;
      }

      // CASO 3: Fallo técnico - No se detectó rostro en selfie
      if (!liveDescriptor) {
        setValidationResult('FAILED');
        setCaptureFailure(true); // ✓ FALLO TÉCNICO: imagen con baja calidad/sin rostro
        const msg = matchingMessages?.badFaceQuality || {};
        const text = msg.text || 'No pude obtener una lectura facial fiable de tu rostro. La imagen tiene baja calidad. Recolócate y vuelve a validar tu rostro.';
        const voice = msg.voice || 'No pude obtener una lectura facial fiable. Recolócate y vuelve a validar tu rostro.';
        setAgentMatchingMessage(text);
        onSpeak?.(voice);
        return;
      }

      const comparingMsg = matchingMessages?.comparing || {};
      const comparingText = comparingMsg.text || 'Comparando datos biométricos...';
      setAgentMatchingMessage(comparingText);

      const distance = faceapi.euclideanDistance(documentDescriptor, liveDescriptor);
      const isMatch = distance <= FACE_MATCH_THRESHOLD;

      // Añade un retraso artificial para que la validación sea más perceptible
      await new Promise(res => setTimeout(res, 3000));

      // CASO 4: Éxito - Datos válidos y coinciden
      if (isMatch) {
        const successMsg = matchingMessages?.success || {};
        const successText = successMsg.text || 'Identidad verificada. Tus datos coinciden con tu documento. Bienvenido.';
        setValidationResult('SUCCESS');
        setCaptureFailure(null); // No aplica
        setAgentMatchingMessage(successText);
        // No hablar el mensaje de éxito, ya que transicionará inmediatamente al siguiente paso
      } 
      // CASO 5: Ataque/Error crítico - Datos válidos pero NO coinciden
      else {
        setValidationResult('FAILED');
        setCaptureFailure(false); // ✗ NO ES FALLO TÉCNICO: es posible suplantación
        const failedMsg = matchingMessages?.failed || {};
        const failedText = failedMsg.text || 'Ataque detectado: los datos no coinciden con la identidad esperada.';
        const failedVoice = failedMsg.voice || 'Ataque detectado. Los datos no coinciden con la identidad esperada.';
        setAgentMatchingMessage(failedText);
        onSpeak?.(failedVoice);
      }
    } catch (e) {
      // CASO 6: Error técnico durante el proceso
      setValidationResult('FAILED');
      setCaptureFailure(true); // Por precaución, es un error técnico pasajero
      const errorMsg = matchingMessages?.error || {};
      const errorText = errorMsg.text || 'Se produjo un error durante la validación biométrica. Reintenta en unos segundos.';
      setAgentMatchingMessage(errorText);
    } finally {
      setIsValidatingMatch(false);
    }
  }, [getFaceDescriptorFromDataUrl]);

  return {
    validationResult,
    setValidationResult,
    isValidatingMatch,
    setIsValidatingMatch,
    agentMatchingMessage,
    setAgentMatchingMessage,
    captureFailure,
    setCaptureFailure,
    runFaceMatch
  };
};
