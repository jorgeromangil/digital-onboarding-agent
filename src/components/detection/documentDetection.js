export const processDocumentFrame = ({
  now,
  metrics,
  detections,
  canvasWidth,
  canvasHeight,
  config,
  refs,
  helpers,
  emitStatus,
  shouldDetectDocument
}) => {
  if (!shouldDetectDocument || !metrics) return false;

  const {
    docLastSignalRef,
    docStableSinceRef,
    docStableFramesRef,
    alignedSinceRef
  } = refs;
  const { getDocumentQualityScore, hasPortraitInsideDocument } = helpers;
  const { areaRatio, aspectRatio, touchesFrame, contrastDelta, fillRatio, glareRatio } = metrics;

  let isDocumentReady = false;
  let portraitDetected = false;

  if (contrastDelta >= config.minContrastDelta
    && Math.abs(aspectRatio - config.targetAspectRatio) <= config.aspectTolerance
    && glareRatio <= config.glareRatio
    && (!touchesFrame || (touchesFrame && areaRatio < config.touchesFrameCloseAreaRatio))) {
    const previousSignal = docLastSignalRef.current;
    const currentSignal = !previousSignal
      ? { areaRatio, aspectRatio, contrastDelta }
      : {
        areaRatio: (previousSignal.areaRatio * (1 - config.emaAlpha)) + (areaRatio * config.emaAlpha),
        aspectRatio: (previousSignal.aspectRatio * (1 - config.emaAlpha)) + (aspectRatio * config.emaAlpha),
        contrastDelta: (previousSignal.contrastDelta * (1 - config.emaAlpha)) + (contrastDelta * config.emaAlpha)
      };

    docLastSignalRef.current = currentSignal;
    const feedbackQuality = getDocumentQualityScore(metrics, currentSignal);
    const area = currentSignal.areaRatio;

    if (feedbackQuality >= config.minFeedbackQuality
      && area >= config.minAreaRatio
      && area <= config.maxAreaRatio) {
      portraitDetected = hasPortraitInsideDocument(metrics.bounds, detections, canvasWidth, canvasHeight);

      if (!previousSignal || !docStableSinceRef.current) {
        docStableSinceRef.current = now;
        docStableFramesRef.current = 1;
        emitStatus('DOC_SEARCHING');
      } else {
        docStableFramesRef.current += 1;
        const qualityScore = getDocumentQualityScore(metrics, currentSignal);

        if (qualityScore >= config.minQualityScore
          && docStableSinceRef.current
          && (now - docStableSinceRef.current >= config.stableMs)
          && docStableFramesRef.current >= config.minStableFrames) {
          isDocumentReady = portraitDetected;
        } else {
          emitStatus('DOC_SEARCHING');
        }
      }
    }
  }

  if (isDocumentReady) {
    emitStatus('DOC_ALIGNED');
    docStableSinceRef.current = null;
    docStableFramesRef.current = 0;
    docLastSignalRef.current = null;
    alignedSinceRef.current = null;
    return true;
  }

  if (docStableSinceRef.current && !portraitDetected) {
    emitStatus('DOC_FACE_REQUIRED');
  }

  return false;
};