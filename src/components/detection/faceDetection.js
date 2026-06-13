export const processFaceFrame = ({
  now,
  detections,
  canvasWidth,
  canvasHeight,
  config,
  refs,
  helpers,
  emitStatus,
  targetDetectionType,
  frameStats
}) => {
  const {
    alignedSinceRef,
    faceStableFramesRef,
    docStableSinceRef,
    docStableFramesRef,
    docLastSignalRef
  } = refs;
  const { hasLowEyeLandmarkConfidence } = helpers;

  let isFaceReady = false;

  if (detections.length === 1) {
    const dominantDetection = detections[0];
    const box = dominantDetection.detection.box;
    const faceWidthRatio = box.width / canvasWidth;

    const centerX = box.x + (box.width / 2);
    const centerY = box.y + (box.height / 2);
    const deltaX = Math.abs(centerX - canvasWidth / 2) / canvasWidth;
    const deltaY = Math.abs(centerY - canvasHeight / 2) / canvasHeight;
    const isCentered = deltaX <= config.centerToleranceX && deltaY <= config.centerToleranceY;

    const hasGoodLighting = frameStats?.mean !== undefined
      && frameStats.mean >= config.underexposedThreshold
      && frameStats.mean <= config.overexposedThreshold;

    if (faceWidthRatio >= config.minWidthRatio
      && isCentered
      && hasGoodLighting
      && !hasLowEyeLandmarkConfidence(dominantDetection, canvasWidth, canvasHeight)) {
      if (!alignedSinceRef.current) {
        alignedSinceRef.current = now;
        faceStableFramesRef.current = 1;
        emitStatus('FACE_SEARCHING');
      } else {
        faceStableFramesRef.current += 1;
      }

      if (now - alignedSinceRef.current >= config.alignedStableMs
        && faceStableFramesRef.current >= config.minStableFrames) {
        isFaceReady = true;
      }

      if (!isFaceReady) {
        emitStatus('FACE_SEARCHING');
      }
    } else {
      alignedSinceRef.current = null;
      faceStableFramesRef.current = 0;
    }
  }

  if (isFaceReady) {
    emitStatus('FACE_ALIGNED');
    alignedSinceRef.current = null;
    docStableSinceRef.current = null;
    docStableFramesRef.current = 0;
    docLastSignalRef.current = null;
    return true;
  }

  if (detections.length === 0) {
    alignedSinceRef.current = null;
    faceStableFramesRef.current = 0;
    if (targetDetectionType === 'DOCUMENT') {
      emitStatus('DOC_SEARCHING');
    } else if (targetDetectionType === 'FACE') {
      emitStatus('FACE_SEARCHING');
    } else {
      emitStatus('SEARCHING');
    }
    return false;
  }

  if (detections.length > 1) {
    alignedSinceRef.current = null;
    faceStableFramesRef.current = 0;
    if (targetDetectionType === 'DOCUMENT') {
      emitStatus('DOC_SEARCHING');
    } else if (targetDetectionType === 'FACE') {
      emitStatus('FACE_SEARCHING');
    } else {
      emitStatus('SEARCHING');
    }
  }

  return false;
};