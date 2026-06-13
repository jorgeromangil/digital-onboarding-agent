import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as faceapi from 'face-api.js';
import { ensureBiometricModelsLoaded } from '../utils/modelLoader';
import { processDocumentFrame } from './detection/documentDetection';
import { processFaceFrame } from './detection/faceDetection';
import {
  estimateDocumentMetricsFromSample,
  estimateDocumentMetricsFromSampleWithScanic,
  initializeScanicScanner,
  getDocumentQualityScoreFromMetrics,
  getFrameStatsFromSample,
  getSampleDataFromVideo,
  hasLowEyeLandmarkConfidenceFromSample,
  hasPortraitInsideDocumentBounds
} from './detection/frameMetrics';

const LOST_THRESHOLD_MS = 3000;
const ALIGNED_STABLE_MS = 800;
const FACE_MIN_STABLE_FRAMES = 3;
const FACE_MIN_WIDTH_RATIO = 0.16;
const DOCUMENT_STABLE_MS = 500;
const CENTER_TOLERANCE_X = 0.18;
const CENTER_TOLERANCE_Y = 0.2;
const UNDEREXPOSED_THRESHOLD = 55;
const OVEREXPOSED_THRESHOLD = 225;
const DOCUMENT_MIN_AREA_RATIO = 0.16;
const DOCUMENT_MAX_AREA_RATIO = 0.9;
const DOCUMENT_EMA_ALPHA = 0.45;
const QUALITY_SAMPLE_WIDTH = 160;
const QUALITY_SAMPLE_HEIGHT = 120;
const DOCUMENT_OBJECT_MIN_PIXELS_RATIO = 0.025;
const DOCUMENT_TARGET_ASPECT_RATIO = 1.58;
const DOCUMENT_ASPECT_TOLERANCE = 0.6;
const DOCUMENT_MIN_CONTRAST_DELTA = 6;
const DOCUMENT_COMPONENT_MIN_FILL_RATIO = 0.04;
const DOCUMENT_GLARE_LUMINANCE = 242;
const DOCUMENT_GLARE_RATIO = 0.12;
const DOCUMENT_DETECTION_INSET_RATIO = 0.02;
const DOCUMENT_MIN_EDGE_PIXELS = 10;
const DOCUMENT_MIN_STABLE_FRAMES = 3;
const DOCUMENT_MIN_QUALITY_SCORE = 0.62;
const DOCUMENT_QUALITY_AREA_TARGET = 0.44;
const DOCUMENT_QUALITY_AREA_TOLERANCE = 0.34;
const DOCUMENT_QUALITY_CONTRAST_GOOD = 24;
const DOCUMENT_TOUCHES_FRAME_CLOSE_AREA_RATIO = 0.82;
const DOCUMENT_MIN_FEEDBACK_QUALITY = 0.24;
const DOCUMENT_PORTRAIT_MIN_AREA_RATIO = 0.01;
const DOCUMENT_PORTRAIT_MAX_AREA_RATIO = 0.36;
const DOCUMENT_PORTRAIT_CENTER_MARGIN = 0.02;

const DEFAULT_DOC_DETECTION_CONFIG = {
  stableMs: DOCUMENT_STABLE_MS,
  minAreaRatio: DOCUMENT_MIN_AREA_RATIO,
  maxAreaRatio: DOCUMENT_MAX_AREA_RATIO,
  emaAlpha: DOCUMENT_EMA_ALPHA,
  objectMinPixelsRatio: DOCUMENT_OBJECT_MIN_PIXELS_RATIO,
  targetAspectRatio: DOCUMENT_TARGET_ASPECT_RATIO,
  aspectTolerance: DOCUMENT_ASPECT_TOLERANCE,
  minContrastDelta: DOCUMENT_MIN_CONTRAST_DELTA,
  componentMinFillRatio: DOCUMENT_COMPONENT_MIN_FILL_RATIO,
  glareLuminance: DOCUMENT_GLARE_LUMINANCE,
  glareRatio: DOCUMENT_GLARE_RATIO,
  detectionInsetRatio: DOCUMENT_DETECTION_INSET_RATIO,
  minEdgePixels: DOCUMENT_MIN_EDGE_PIXELS,
  minStableFrames: DOCUMENT_MIN_STABLE_FRAMES,
  minQualityScore: DOCUMENT_MIN_QUALITY_SCORE,
  qualityAreaTarget: DOCUMENT_QUALITY_AREA_TARGET,
  qualityAreaTolerance: DOCUMENT_QUALITY_AREA_TOLERANCE,
  qualityContrastGood: DOCUMENT_QUALITY_CONTRAST_GOOD,
  touchesFrameCloseAreaRatio: DOCUMENT_TOUCHES_FRAME_CLOSE_AREA_RATIO,
  minFeedbackQuality: DOCUMENT_MIN_FEEDBACK_QUALITY
};

const DEFAULT_FACE_DETECTION_CONFIG = {
  lostThresholdMs: LOST_THRESHOLD_MS,
  alignedStableMs: ALIGNED_STABLE_MS,
  minStableFrames: FACE_MIN_STABLE_FRAMES,
  minWidthRatio: FACE_MIN_WIDTH_RATIO,
  centerToleranceX: CENTER_TOLERANCE_X,
  centerToleranceY: CENTER_TOLERANCE_Y,
  underexposedThreshold: UNDEREXPOSED_THRESHOLD,
  overexposedThreshold: OVEREXPOSED_THRESHOLD,
  minDetectionScore: 0.72,
  eyeDarkMeanThreshold: 45,
  eyeDarkStdThreshold: 14,
  minEyeWidth: 5,
  minEyeHeight: 0.9
};

const VideoCanvas = forwardRef(({
  onCameraReady,
  onGuidanceStatusChange,
  startCamera,
  detectionConfig
}, ref) => {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectionIntervalRef = useRef(null);
  const qualityCanvasRef = useRef(null);
  const alignedSinceRef = useRef(null);
  const lastValidTargetTypeRef = useRef(null); // Guardar el último targetDetectionType válido
  const faceStableFramesRef = useRef(0);
  const docStableSinceRef = useRef(null);
  const docStableFramesRef = useRef(0);
  const docLastSignalRef = useRef(null);
  const currentStatusRef = useRef('DOC_SEARCHING');
  const [errorMsg, setErrorMsg] = useState('');
  const [isStreamReady, setIsStreamReady] = useState(false);
  const defaultFacingMode = 'user';
  const [cameraFacingMode, setCameraFacingMode] = useState(defaultFacingMode);
  const [hasManualFacingSelection, setHasManualFacingSelection] = useState(false);
  const targetDetectionType = detectionConfig?.targetDetectionType || null;
  const shouldDetectDocument = targetDetectionType !== 'FACE';
  const shouldDetectFace = targetDetectionType !== 'DOCUMENT';
  const activeDocConfig = {
    ...DEFAULT_DOC_DETECTION_CONFIG,
    ...(detectionConfig || {})
  };
  const activeFaceConfig = {
    ...DEFAULT_FACE_DETECTION_CONFIG,
    ...(detectionConfig || {})
  };

  const emitStatus = useCallback((nextStatus) => {
    if (currentStatusRef.current === nextStatus) return;
    currentStatusRef.current = nextStatus;
    onGuidanceStatusChange?.(nextStatus);
  }, [onGuidanceStatusChange]);

  const getSampleData = useCallback(() => getSampleDataFromVideo({
    video: videoRef.current,
    qualityCanvasRef,
    sampleWidth: QUALITY_SAMPLE_WIDTH,
    sampleHeight: QUALITY_SAMPLE_HEIGHT
  }), []);

  const getFrameStats = useCallback(() => {
    const sample = getSampleData();
    return getFrameStatsFromSample(sample);
  }, [getSampleData]);

  const estimateDocumentMetrics = useCallback(async () => {
    const sample = getSampleData();
    if (!sample) return null;
    
    // Try SCANIC first, fall back to heuristic if it fails
    const metricsSCANIC = await estimateDocumentMetricsFromSampleWithScanic(sample, activeDocConfig);
    if (metricsSCANIC) return metricsSCANIC;
    
    // Fallback to heuristic detection
    return estimateDocumentMetricsFromSample(sample, activeDocConfig);
  }, [activeDocConfig, getSampleData]);

  const getDocumentQualityScore = useCallback((metrics, smoothedSignal) => {
    return getDocumentQualityScoreFromMetrics(metrics, smoothedSignal, activeDocConfig);
  }, [activeDocConfig]);

  const hasLowEyeLandmarkConfidence = useCallback((detection, canvasWidth, canvasHeight) => {
    const sample = getSampleData();
    return hasLowEyeLandmarkConfidenceFromSample({
      detection,
      canvasWidth,
      canvasHeight,
      sample,
      faceCfg: activeFaceConfig
    });
  }, [activeFaceConfig, getSampleData]);

  const hasPortraitInsideDocument = useCallback((documentBounds, detections, canvasWidth, canvasHeight) => {
    return hasPortraitInsideDocumentBounds({
      documentBounds,
      detections,
      canvasWidth,
      canvasHeight,
      centerMargin: DOCUMENT_PORTRAIT_CENTER_MARGIN,
      minAreaRatio: DOCUMENT_PORTRAIT_MIN_AREA_RATIO,
      maxAreaRatio: DOCUMENT_PORTRAIT_MAX_AREA_RATIO
    });
  }, []);

  useImperativeHandle(ref, () => ({
    captureCurrentFrame: () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return null;

      const captureCanvas = document.createElement('canvas');
      captureCanvas.width = video.videoWidth;
      captureCanvas.height = video.videoHeight;
      const captureCtx = captureCanvas.getContext('2d');
      if (!captureCtx) return null;

      captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
      return captureCanvas.toDataURL('image/jpeg', 0.92);
    }
  }), []);

  useEffect(() => {
    if (hasManualFacingSelection) return;
    setCameraFacingMode(defaultFacingMode);
  }, [defaultFacingMode, hasManualFacingSelection]);

  const handleToggleCameraFacing = useCallback(() => {
    setHasManualFacingSelection(true);
    setCameraFacingMode((prev) => (prev === 'user' ? 'environment' : 'user'));
  }, []);

  useEffect(() => {
    if (!startCamera) return;

    const loadModelsAndStart = async () => {
      try {
        setErrorMsg('');
        await ensureBiometricModelsLoaded();
        // Initialize SCANIC document detection (fire and forget, graceful fallback)
        initializeScanicScanner().catch(() => {
          console.warn('SCANIC initialization failed, falling back to heuristic detection');
        });
        const useRearCamera = cameraFacingMode === 'environment';

        let stream = null;
        if (useRearCamera) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: { ideal: 'environment' }
              }
            });
          } catch {
            stream = null;
          }
        } else {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: { ideal: 'user' }
              }
            });
          } catch {
            stream = null;
          }
        }

        if (!stream) {
          const fallbackVideoConstraints = useRearCamera
            ? { facingMode: { ideal: 'user' } }
            : { facingMode: { ideal: 'environment' } };

          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: fallbackVideoConstraints
            });
          } catch {
            stream = await navigator.mediaDevices.getUserMedia({ video: true });
          }
        }

        streamRef.current = stream;
        if (videoRef.current) {
          setIsStreamReady(false);
          videoRef.current.srcObject = null;
          videoRef.current.srcObject = stream;
          alignedSinceRef.current = null;
          faceStableFramesRef.current = 0;
          docStableSinceRef.current = null;
          docStableFramesRef.current = 0;
          docLastSignalRef.current = null;
          emitStatus(
            targetDetectionType === 'DOCUMENT'
              ? 'DOC_SEARCHING'
              : targetDetectionType === 'FACE'
                ? 'FACE_SEARCHING'
                : 'SEARCHING'
          );
        } else {
          setErrorMsg('No se pudo inicializar el video.');
        }
      } catch {
        setErrorMsg('No se pudo acceder a la cámara o cargar los modelos. Revisa los permisos y la consola.');
      }
    };

    loadModelsAndStart();

    return () => {
      if (detectionIntervalRef.current) {
        clearInterval(detectionIntervalRef.current);
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      currentStatusRef.current = 'DOC_SEARCHING';
    };
  }, [cameraFacingMode, emitStatus, onCameraReady, startCamera]);

  useEffect(() => {
    alignedSinceRef.current = null;
    faceStableFramesRef.current = 0;
    docStableSinceRef.current = null;
    docStableFramesRef.current = 0;
    docLastSignalRef.current = null;
    currentStatusRef.current = targetDetectionType === 'DOCUMENT'
      ? 'DOC_SEARCHING'
      : targetDetectionType === 'FACE'
        ? 'FACE_SEARCHING'
        : 'SEARCHING'; // Reset para sincronizar con el nuevo target
    
    // Guardar el último targetDetectionType válido (no null)
    if (targetDetectionType !== null) {
      lastValidTargetTypeRef.current = targetDetectionType;
    }
    
    if (targetDetectionType === 'DOCUMENT') {
      emitStatus('DOC_SEARCHING');
      return;
    }
    if (targetDetectionType === 'FACE') {
      emitStatus('FACE_SEARCHING');
      return;
    }
    emitStatus(currentStatusRef.current);
  }, [targetDetectionType, emitStatus]);

  const handleVideoPlay = () => {
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
    }

    setIsStreamReady(true);
    if (onCameraReady) onCameraReady();

    detectionIntervalRef.current = setInterval(async () => {
      if (videoRef.current) {
        const now = Date.now();

        const videoWidth = videoRef.current.videoWidth || videoRef.current.clientWidth || 1;
        const videoHeight = videoRef.current.videoHeight || videoRef.current.clientHeight || 1;

        const metrics = await estimateDocumentMetrics();
        const detections = await faceapi
          .detectAllFaces(videoRef.current, new faceapi.TinyFaceDetectorOptions())
          .withFaceLandmarks();

        const docHandled = processDocumentFrame({
          now,
          metrics,
          detections,
          canvasWidth: videoWidth,
          canvasHeight: videoHeight,
          config: activeDocConfig,
          refs: {
            docLastSignalRef,
            docStableSinceRef,
            docStableFramesRef,
            alignedSinceRef
          },
          helpers: {
            getDocumentQualityScore,
            hasPortraitInsideDocument
          },
          emitStatus,
          shouldDetectDocument
        });

        if (docHandled && currentStatusRef.current === 'DOC_ALIGNED') {
          return;
        }

        processFaceFrame({
          now,
          detections: shouldDetectFace ? detections : [],
          canvasWidth: videoWidth,
          canvasHeight: videoHeight,
          config: activeFaceConfig,
          refs: {
            alignedSinceRef,
            faceStableFramesRef,
            docStableSinceRef,
            docStableFramesRef,
            docLastSignalRef
          },
          helpers: {
            hasLowEyeLandmarkConfidence
          },
          emitStatus,
          targetDetectionType: lastValidTargetTypeRef.current || targetDetectionType,
          frameStats: getFrameStats()
        });
      }
    }, 350);
  };

  return (
    <div style={{ position: 'relative' }}>
      {errorMsg && (
        <div style={{ color: 'red', marginBottom: '10px' }}>{errorMsg}</div>
      )}

      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '0.9 / 1',
          boxSizing: 'border-box',
          margin: '0 auto',
          borderRadius: '15px',
          border: '1px solid #ffffff33',
          overflow: 'hidden',
          display: startCamera ? 'block' : 'none'
        }}
      >
        <video
          ref={videoRef}
          onPlay={handleVideoPlay}
          onLoadedMetadata={() => {
            const video = videoRef.current;
            if (!video) return;
            video.play().catch(() => {});
          }}
          autoPlay
          muted
          playsInline
          style={{
            width: '100%',
            height: '100%',
            display: isStreamReady ? 'block' : 'none',
            objectFit: 'cover',
            transform: cameraFacingMode === 'user' ? 'scaleX(-1)' : 'none',
            background: '#000'
          }}
        />

        {!isStreamReady && startCamera && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: '#000'
            }}
          />
        )}

        {startCamera && (
          <button
            type="button"
            onClick={handleToggleCameraFacing}
            className="camera-flip-button"
            title={cameraFacingMode === 'user' ? 'Cambiar a cámara trasera' : 'Cambiar a cámara frontal'}
            aria-label={cameraFacingMode === 'user' ? 'Cambiar a cámara trasera' : 'Cambiar a cámara frontal'}
            style={{
              position: 'absolute',
              bottom: '12px',
              right: '12px',
              zIndex: 10
            }}
          >
            <span className="material-symbols-outlined">cameraswitch</span>
          </button>
        )}

      </div>

      {startCamera && (
        <p style={{ marginTop: '10px', fontSize: '14px', color: '#ffffffb3' }}>
          Muestra tu DNI o tu cara ante la cámara. Para capturar el DNI, debe verse bien la foto.
        </p>
      )}
    </div>
  );
});

export default VideoCanvas;