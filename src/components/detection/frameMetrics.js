import { Scanner } from 'scanic';

// SCANIC singleton instance
let scannerInstance = null;
let scannerInitializing = false;
let scannerReady = false;

/**
 * Initialize SCANIC scanner (call once during app startup)
 */
export const initializeScanicScanner = async () => {
  if (scannerReady || scannerInitializing) return;
  
  try {
    scannerInitializing = true;
    scannerInstance = new Scanner();
    await scannerInstance.initialize();
    scannerReady = true;
  } catch (error) {
    console.error('Failed to initialize SCANIC scanner:', error);
    scannerInitializing = false;
  }
};

/**
 * Calculate document metrics from SCANIC detection results
 * Maps SCANIC corners to the same metric format as the heuristic version
 */
const metricsFromScanicCorners = (corners, sampleWidth, sampleHeight, sample, docCfg) => {
  if (!corners) return null;

  const { topLeft, topRight, bottomLeft, bottomRight } = corners;

  // Calculate bounding box from corners
  const xs = [topLeft.x, topRight.x, bottomLeft.x, bottomRight.x];
  const ys = [topLeft.y, topRight.y, bottomLeft.y, bottomRight.y];
  
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(sampleWidth - 1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(sampleHeight - 1, Math.ceil(Math.max(...ys)));

  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;

  if (boxWidth < 5 || boxHeight < 5) return null;

  // Calculate metrics from bounding box
  const insetX = Math.max(Math.floor(sampleWidth * docCfg.detectionInsetRatio), 1);
  const insetY = Math.max(Math.floor(sampleHeight * docCfg.detectionInsetRatio), 1);
  const guideMinX = insetX;
  const guideMinY = insetY;
  const guideMaxX = Math.min(sampleWidth - insetX - 1, sampleWidth - 1);
  const guideMaxY = Math.min(sampleHeight - insetY - 1, sampleHeight - 1);
  const roiPixels = Math.max((guideMaxX - guideMinX + 1) * (guideMaxY - guideMinY + 1), 1);

  const areaRatio = (boxWidth * boxHeight) / roiPixels;
  const aspectRatio = boxWidth / boxHeight;
  const touchesFrame = minX <= 1 || minY <= 1 || maxX >= sampleWidth - 2 || maxY >= sampleHeight - 2;

  // Calculate contrast and glare from luminance data (sample)
  const { data, width, height } = sample;

  let outsideSum = 0;
  let outsideSqSum = 0;
  let outsideCount = 0;
  let insideSum = 0;
  let insideCount = 0;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const pixelIndex = (y * width + x) * 4;
      const red = data[pixelIndex];
      const green = data[pixelIndex + 1];
      const blue = data[pixelIndex + 2];
      const lum = 0.2126 * red + 0.7152 * green + 0.0722 * blue;

      insideSum += lum;
      insideCount += 1;
    }
  }

  // Calculate outside luminance (background)
  if (guideMinX < guideMaxX && guideMinY < guideMaxY) {
    for (let y = guideMinY; y <= guideMaxY; y += 1) {
      for (let x = guideMinX; x <= guideMaxX; x += 1) {
        if (x < minX || x > maxX || y < minY || y > maxY) {
          const pixelIndex = (y * width + x) * 4;
          const red = data[pixelIndex];
          const green = data[pixelIndex + 1];
          const blue = data[pixelIndex + 2];
          const lum = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
          outsideSum += lum;
          outsideSqSum += lum * lum;
          outsideCount += 1;
        }
      }
    }
  }

  const outsideMean = outsideCount > 0 ? outsideSum / outsideCount : 128;
  const outsideVariance = outsideCount > 0 ? Math.max((outsideSqSum / outsideCount) - (outsideMean * outsideMean), 0) : 0;
  const roiMean = insideCount > 0 ? insideSum / insideCount : 128;
  const contrastDelta = Math.abs(roiMean - outsideMean);

  // Calculate glare ratio
  let glarePixels = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const pixelIndex = (y * width + x) * 4;
      const red = data[pixelIndex];
      const green = data[pixelIndex + 1];
      const blue = data[pixelIndex + 2];
      const lum = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      
      if (lum >= docCfg.glareLuminance) glarePixels += 1;
    }
  }
  const glareRatio = insideCount > 0 ? glarePixels / insideCount : 0;

  // Estimate fillRatio from box size (since SCANIC provides exact corners)
  const fillRatio = 0.85; // SCANIC corners are precise, so high fill ratio

  return {
    areaRatio,
    aspectRatio,
    touchesFrame,
    contrastDelta,
    fillRatio,
    glareRatio,
    bounds: {
      minX: minX / width,
      minY: minY / height,
      maxX: maxX / width,
      maxY: maxY / height
    }
  };
};

/**
 * Estimate document metrics using SCANIC (ML-based detection)
 * Falls back to null if SCANIC is not ready
 */
export const estimateDocumentMetricsFromSampleWithScanic = async (sample, docCfg) => {
  if (!scannerReady || !sample) return null;

  try {
    const { data, width, height } = sample;
    
    // Create ImageData for SCANIC
    const imageData = new ImageData(data, width, height);
    
    // Run SCANIC detection
    const result = await scannerInstance.scan(imageData, { mode: 'detect' });
    
    if (!result.success || !result.corners) return null;
    
    // Convert SCANIC corners to our metrics format
    return metricsFromScanicCorners(result.corners, width, height, sample, docCfg);
  } catch (error) {
    console.error('SCANIC detection error:', error);
    return null;
  }
};

export const getSampleDataFromVideo = ({
  video,
  qualityCanvasRef,
  sampleWidth,
  sampleHeight
}) => {
  if (!video || video.readyState < 2) return null;

  if (!qualityCanvasRef.current) {
    qualityCanvasRef.current = document.createElement('canvas');
    qualityCanvasRef.current.width = sampleWidth;
    qualityCanvasRef.current.height = sampleHeight;
  }

  const ctx = qualityCanvasRef.current.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(video, 0, 0, sampleWidth, sampleHeight);
  const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);

  return {
    data,
    width: sampleWidth,
    height: sampleHeight
  };
};

export const getFrameStatsFromSample = (sample) => {
  if (!sample) return null;

  const { data } = sample;
  let luminanceSum = 0;
  let luminanceSqSum = 0;
  let samples = 0;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    luminanceSum += luminance;
    luminanceSqSum += luminance * luminance;
    samples += 1;
  }

  if (samples === 0) return null;

  const mean = luminanceSum / samples;
  const variance = Math.max((luminanceSqSum / samples) - (mean * mean), 0);

  return {
    mean,
    std: Math.sqrt(variance),
    sample
  };
};

export const estimateDocumentMetricsFromSample = (sample, docCfg) => {
  if (!sample || !docCfg) return null;

  const { data, width, height } = sample;
  const insetX = Math.max(Math.floor(width * docCfg.detectionInsetRatio), 1);
  const insetY = Math.max(Math.floor(height * docCfg.detectionInsetRatio), 1);
  const guideMinX = insetX;
  const guideMinY = insetY;
  const guideMaxX = Math.min(width - insetX - 1, width - 1);
  const guideMaxY = Math.min(height - insetY - 1, height - 1);
  const roiPixels = Math.max((guideMaxX - guideMinX + 1) * (guideMaxY - guideMinY + 1), 1);
  const luminance = new Float32Array(width * height);
  const sampleWidth = guideMaxX - guideMinX + 1;
  const sampleHeight = guideMaxY - guideMinY + 1;

  let outsideSum = 0;
  let outsideSqSum = 0;
  let outsideCount = 0;
  let insideSum = 0;
  let insideCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const pixelIndex = index * 4;
      const red = data[pixelIndex];
      const green = data[pixelIndex + 1];
      const blue = data[pixelIndex + 2];
      const lum = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      luminance[index] = lum;

      const isInsideRoi = x >= guideMinX && x <= guideMaxX && y >= guideMinY && y <= guideMaxY;
      if (isInsideRoi) {
        insideSum += lum;
        insideCount += 1;
      } else {
        outsideSum += lum;
        outsideSqSum += lum * lum;
        outsideCount += 1;
      }
    }
  }

  if (insideCount === 0 || outsideCount === 0) return null;

  const outsideMean = outsideSum / outsideCount;
  const outsideVariance = Math.max((outsideSqSum / outsideCount) - (outsideMean * outsideMean), 0);
  const outsideStd = Math.sqrt(outsideVariance);
  const roiMean = insideSum / insideCount;
  const contrastDelta = Math.abs(roiMean - outsideMean);

  let glarePixels = 0;
  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const originalX = guideMinX + x;
      const originalY = guideMinY + y;
      const lum = luminance[originalY * width + originalX];
      if (lum >= docCfg.glareLuminance) glarePixels += 1;
    }
  }
  const glareRatio = glarePixels / insideCount;

  const edgeThreshold = Math.max(outsideStd * 0.95, 12);
  const mask = new Uint8Array(sampleWidth * sampleHeight);
  const edges = new Uint8Array(sampleWidth * sampleHeight);

  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const originalX = guideMinX + x;
      const originalY = guideMinY + y;
      const lum = luminance[originalY * width + originalX];
      const isObjectPixel = Math.abs(lum - outsideMean) > edgeThreshold;

      if (isObjectPixel) {
        mask[y * sampleWidth + x] = 1;
      }

      if (x > 0 && y > 0) {
        const lumLeft = luminance[originalY * width + (originalX - 1)];
        const lumUp = luminance[(originalY - 1) * width + originalX];
        const edginess = Math.abs(lum - lumLeft) + Math.abs(lum - lumUp);
        if (edginess > outsideStd * 2) {
          edges[y * sampleWidth + x] = 1;
        }
      }
    }
  }

  const visited = new Uint8Array(sampleWidth * sampleHeight);
  let largestComponentPixels = 0;
  let largestComponentScore = 0;
  let bestComponentMinX = sampleWidth;
  let bestComponentMinY = sampleHeight;
  let bestComponentMaxX = 0;
  let bestComponentMaxY = 0;
  let bestComponentEdges = 0;

  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const startIndex = y * sampleWidth + x;
      if (!mask[startIndex] || visited[startIndex]) continue;

      const queue = [startIndex];
      visited[startIndex] = 1;
      let head = 0;
      let componentPixels = 0;
      let componentMinX = x;
      let componentMinY = y;
      let componentMaxX = x;
      let componentMaxY = y;
      let componentEdges = 0;

      while (head < queue.length) {
        const index = queue[head];
        head += 1;
        componentPixels += 1;

        const cx = index % sampleWidth;
        const cy = Math.floor(index / sampleWidth);
        componentMinX = Math.min(componentMinX, cx);
        componentMinY = Math.min(componentMinY, cy);
        componentMaxX = Math.max(componentMaxX, cx);
        componentMaxY = Math.max(componentMaxY, cy);

        if (edges[index]) componentEdges += 1;

        const neighbors = [
          index - 1,
          index + 1,
          index - sampleWidth,
          index + sampleWidth
        ];

        for (let n = 0; n < neighbors.length; n += 1) {
          const next = neighbors[n];
          if (next < 0 || next >= mask.length) continue;

          const nx = next % sampleWidth;
          const ny = Math.floor(next / sampleWidth);
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          if (!mask[next] || visited[next]) continue;

          visited[next] = 1;
          queue.push(next);
        }
      }

      const edgeScore = componentEdges / Math.max(componentPixels, 1);
      const score = componentPixels * (0.5 + edgeScore * 0.5);

      if (score > largestComponentScore) {
        largestComponentScore = score;
        largestComponentPixels = componentPixels;
        bestComponentMinX = componentMinX;
        bestComponentMinY = componentMinY;
        bestComponentMaxX = componentMaxX;
        bestComponentMaxY = componentMaxY;
        bestComponentEdges = componentEdges;
      }
    }
  }

  if ((largestComponentPixels / roiPixels) < docCfg.objectMinPixelsRatio) {
    return null;
  }

  const boxWidth = Math.max(bestComponentMaxX - bestComponentMinX + 1, 1);
  const boxHeight = Math.max(bestComponentMaxY - bestComponentMinY + 1, 1);
  const areaRatio = (boxWidth * boxHeight) / roiPixels;
  const aspectRatio = boxWidth / boxHeight;
  const fillRatio = largestComponentPixels / (boxWidth * boxHeight);
  const touchesFrame = bestComponentMinX <= 1
    || bestComponentMinY <= 1
    || bestComponentMaxX >= sampleWidth - 2
    || bestComponentMaxY >= sampleHeight - 2;

  if (bestComponentEdges < docCfg.minEdgePixels) {
    return null;
  }

  if (fillRatio < docCfg.componentMinFillRatio) {
    return null;
  }

  const absoluteMinX = guideMinX + bestComponentMinX;
  const absoluteMinY = guideMinY + bestComponentMinY;
  const absoluteMaxX = guideMinX + bestComponentMaxX;
  const absoluteMaxY = guideMinY + bestComponentMaxY;

  return {
    areaRatio,
    aspectRatio,
    touchesFrame,
    contrastDelta,
    fillRatio,
    glareRatio,
    bounds: {
      minX: absoluteMinX / width,
      minY: absoluteMinY / height,
      maxX: absoluteMaxX / width,
      maxY: absoluteMaxY / height
    }
  };
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export const getDocumentQualityScoreFromMetrics = (metrics, smoothedSignal, docCfg) => {
  if (!metrics || !smoothedSignal || !docCfg) return 0;

  const areaDistance = Math.abs(smoothedSignal.areaRatio - docCfg.qualityAreaTarget);
  const areaScore = 1 - clamp01(areaDistance / Math.max(docCfg.qualityAreaTolerance, 0.01));
  const aspectDistance = Math.abs(smoothedSignal.aspectRatio - docCfg.targetAspectRatio);
  const aspectScore = 1 - clamp01(aspectDistance / Math.max(docCfg.aspectTolerance, 0.01));
  const contrastScore = clamp01((smoothedSignal.contrastDelta - docCfg.minContrastDelta)
    / Math.max(docCfg.qualityContrastGood - docCfg.minContrastDelta, 1));
  const glareScore = 1 - clamp01(metrics.glareRatio / Math.max(docCfg.glareRatio, 0.01));

  const rawScore = (areaScore * 0.3) + (aspectScore * 0.25) + (contrastScore * 0.25) + (glareScore * 0.2);
  const frameTouchPenalty = metrics.touchesFrame ? 0.86 : 1;
  return rawScore * frameTouchPenalty;
};

export const getEyeRegionStatsFromSample = (landmarks, canvasWidth, canvasHeight, sample) => {
  if (!sample || !landmarks) return null;

  const { width, height, data } = sample;
  const allEyePoints = [...landmarks.getLeftEye(), ...landmarks.getRightEye()];
  if (allEyePoints.length === 0) return null;

  const scaleX = width / Math.max(canvasWidth, 1);
  const scaleY = height / Math.max(canvasHeight, 1);

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  allEyePoints.forEach((point) => {
    const x = Math.floor(point.x * scaleX);
    const y = Math.floor(point.y * scaleY);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });

  minX = Math.max(minX - 2, 0);
  minY = Math.max(minY - 2, 0);
  maxX = Math.min(maxX + 2, width - 1);
  maxY = Math.min(maxY + 2, height - 1);

  let sum = 0;
  let sqSum = 0;
  let count = 0;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const pixelIndex = (y * width + x) * 4;
      const red = data[pixelIndex];
      const green = data[pixelIndex + 1];
      const blue = data[pixelIndex + 2];
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      sum += luminance;
      sqSum += luminance * luminance;
      count += 1;
    }
  }

  if (count === 0) return null;

  const mean = sum / count;
  const variance = Math.max((sqSum / count) - (mean * mean), 0);

  return {
    mean,
    std: Math.sqrt(variance)
  };
};

export const hasLowEyeLandmarkConfidenceFromSample = ({
  detection,
  canvasWidth,
  canvasHeight,
  sample,
  faceCfg
}) => {
  if (!detection || !faceCfg) return true;

  const landmarks = detection.landmarks;
  if (!landmarks) return true;

  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  const isEyeShapeValid = (eyePoints) => {
    if (!eyePoints || eyePoints.length < 6) return false;

    const xs = eyePoints.map((point) => point.x);
    const ys = eyePoints.map((point) => point.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    return width > faceCfg.minEyeWidth && height > faceCfg.minEyeHeight;
  };

  const shapeReliable = isEyeShapeValid(leftEye) && isEyeShapeValid(rightEye);
  const eyeStats = getEyeRegionStatsFromSample(landmarks, canvasWidth, canvasHeight, sample);
  const darkUniformEyeRegion = eyeStats
    && eyeStats.mean < faceCfg.eyeDarkMeanThreshold
    && eyeStats.std < faceCfg.eyeDarkStdThreshold;
  const detectionConfidence = detection.detection.score ?? 1;

  return !shapeReliable || darkUniformEyeRegion || detectionConfidence < faceCfg.minDetectionScore;
};

export const hasPortraitInsideDocumentBounds = ({
  documentBounds,
  detections,
  canvasWidth,
  canvasHeight,
  centerMargin,
  minAreaRatio,
  maxAreaRatio
}) => {
  if (!documentBounds || !detections?.length || canvasWidth <= 0 || canvasHeight <= 0) return false;

  const minX = documentBounds.minX + centerMargin;
  const minY = documentBounds.minY + centerMargin;
  const maxX = documentBounds.maxX - centerMargin;
  const maxY = documentBounds.maxY - centerMargin;
  if (minX >= maxX || minY >= maxY) return false;

  const docWidth = Math.max(documentBounds.maxX - documentBounds.minX, 0.001);
  const docHeight = Math.max(documentBounds.maxY - documentBounds.minY, 0.001);
  const docArea = docWidth * docHeight;

  return detections.some((detection) => {
    const box = detection.detection?.box;
    if (!box) return false;

    const centerX = (box.x + (box.width / 2)) / canvasWidth;
    const centerY = (box.y + (box.height / 2)) / canvasHeight;
    if (centerX < minX || centerX > maxX || centerY < minY || centerY > maxY) return false;

    const faceArea = (box.width / canvasWidth) * (box.height / canvasHeight);
    const areaRatioInDocument = faceArea / docArea;
    return areaRatioInDocument >= minAreaRatio && areaRatioInDocument <= maxAreaRatio;
  });
};
