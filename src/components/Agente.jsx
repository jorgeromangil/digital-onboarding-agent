import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFaceMatching } from '../hooks/useFaceMatching';
import VideoCanvas from './VideoCanvas';

const getGuidanceMessage = (action, status, guidanceMessages) => {
  if (action === 'capture_auto' && guidanceMessages?.guidance) {
    return guidanceMessages.guidance[status] || null;
  }
  return null;
};

const Agente = ({ 
  stepData, 
  onStepComplete, 
  onValidationComplete,
  isTransitioning = false, 
  guidanceStatus, 
  onGuidanceStatusChange, 
  flowState,
  onDetectionType,
  onRecaptureType,
  completedCaptures = {},
  onCapturedImage,
  capturedImages = {},
  isMuted = false
}) => {
  const audioRef = useRef(null);
  const videoCanvasRef = useRef(null);
  const stepSpeechLockUntilRef = useRef(0);
  const audioUnlockedRef = useRef(false);
  const autoCapturedStepRef = useRef('');
  const autoCaptureTimeoutRef = useRef(null);
  const lastSpokenStatusRef = useRef('');
  const stepAudioFallbackTriggeredRef = useRef(false);
  const previousStepIdRef = useRef(stepData?.id || null);
  const messageDisplayUntilRef = useRef(0); // Timestamp hasta cuando mostrar el mensaje actual
  const guidanceDebounceRef = useRef(null); // Para debounce de cambios de guidance
  const autoValidationTimeoutRef = useRef(null); // Para timeout de validación automática en 6 segundos
  const isMutedRef = useRef(isMuted); // Ref para acceder a isMuted sin cambiar speak
  const captureFeedbackLockUntilRef = useRef(0);
  const lastPostCapturePromptKeyRef = useRef('');
  
  // Actualizar ref cuando cambia isMuted, pero no afecta a speak
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  const [cameraReady, setCameraReady] = useState(false);
  const [cameraStarted, setCameraStarted] = useState(false);
  const [agentMessage, setAgentMessage] = useState(stepData?.text || '');
  const [captureUiLockUntil, setCaptureUiLockUntil] = useState(0);
  const hasCameraEverBeenReadyRef = useRef(false);

  // Hook para validación biométrica
  const {
    validationResult,
    setValidationResult,
    isValidatingMatch,
    setIsValidatingMatch,
    agentMatchingMessage,
    captureFailure,
    runFaceMatch: runFaceMatchHook
  } = useFaceMatching();

  // Definir speak sin isMuted en dependencias, usará isMutedRef
  const speak = useCallback((message, options = {}) => {
    if (!message || typeof window === 'undefined' || !window.speechSynthesis) return;
    if (isMutedRef.current) return;

    const { interrupt = true } = options;

    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = 'es-ES';
    utterance.rate = 1;
    if (interrupt) {
      window.speechSynthesis.cancel();
    }
    window.speechSynthesis.speak(utterance);
  }, []);

  // Wrapper para integrar el hook con el contexto de Agente
  const runFaceMatch = useCallback(async () => {
    // No cambiar el mensaje mientras se valida - mantener el del paso actual
    // El efecto de abajo actualizará el mensaje cuando termina
    setIsValidatingMatch(true);
    await runFaceMatchHook(capturedImages, speak, stepData?.messages?.matching);
  }, [runFaceMatchHook, capturedImages, speak, stepData?.messages]);

  const isVideoStep = stepData?.type === 'video_auto';
  const action = stepData?.action || null;
  const docCaptureHoldMs = stepData?.detection?.captureHoldMs ?? 900;
  const faceCaptureHoldMs = stepData?.detection?.faceCaptureHoldMs ?? 650;
  const minAlignedMessageLeadMs = 2200;
  const captureFeedbackHoldMs = 1400;
  
  // Centralizar lógica: qué tipo debería detectar basado en qué falta
  const targetDetectionType = useMemo(() => {
    if (action !== 'capture_auto') return null;
    if (!completedCaptures.DOCUMENT && completedCaptures.FACE) return 'DOCUMENT';
    if (completedCaptures.DOCUMENT && !completedCaptures.FACE) return 'FACE';
    return null;
  }, [action, completedCaptures.DOCUMENT, completedCaptures.FACE]);
  
  const effectiveDetectionConfig = useMemo(() => ({
    ...(stepData?.detection || {}),
    targetDetectionType
  }), [targetDetectionType, stepData?.detection]);

  const unlockAudioByGesture = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (audioUnlockedRef.current) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      try {
        const context = new AudioContextClass();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0;
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.01);
        context.resume().catch(() => {});
      } catch {
        // Ignore unlock errors and continue with regular fallbacks.
      }
    }

    if (window.speechSynthesis) {
      try {
        const unlockUtterance = new SpeechSynthesisUtterance(' ');
        unlockUtterance.volume = 0;
        window.speechSynthesis.speak(unlockUtterance);
        window.speechSynthesis.cancel();
      } catch {
        // Ignore unlock errors and continue with regular fallbacks.
      }
    }

    audioUnlockedRef.current = true;
  }, []);

  const setDefaultGuidanceForStep = useCallback(() => {
    if (!isVideoStep) return;

    const allCapturesComplete = completedCaptures.DOCUMENT && completedCaptures.FACE;
    if (allCapturesComplete) return;

    if (targetDetectionType === 'DOCUMENT') {
      onGuidanceStatusChange?.('DOC_SEARCHING');
      return;
    }
    if (targetDetectionType === 'FACE') {
      onGuidanceStatusChange?.('FACE_SEARCHING');
      return;
    }
    onGuidanceStatusChange?.('SEARCHING');
  }, [completedCaptures.DOCUMENT, completedCaptures.FACE, targetDetectionType, isVideoStep, onGuidanceStatusChange]);

  useEffect(() => {
    let voiceFallbackTimer = null;
    const previousStepId = previousStepIdRef.current;
    const nextStepId = stepData?.id || null;
    const isSameStepId = previousStepId === nextStepId;
    const isCaptureSubstateUpdate = isSameStepId && nextStepId === 'AUTO_CAPTURE';
    const shouldPreserveCaptureMessage = Date.now() < messageDisplayUntilRef.current;

    queueMicrotask(() => {
      if (!isVideoStep) {
        setCameraReady(false);
        setCameraStarted(false);
      } else {
        if (!isSameStepId) {
          setCameraReady(false);
        }
        setCameraStarted(true);
      }

      if (!isCaptureSubstateUpdate) {
        setIsValidatingMatch(false);
        setValidationResult('IDLE');
      }

      if (!shouldPreserveCaptureMessage) {
        setAgentMessage(stepData?.text || '');
      }

      if (!isCaptureSubstateUpdate) {
        setAgentMatchingMessage(''); // Resetear mensaje de validación al cambiar de paso
      }

      if (stepData?.id === 'WELCOME') {
        // No need to reset anything, captured images stay in parent state
      }

      previousStepIdRef.current = nextStepId;
    });

    lastSpokenStatusRef.current = '';
    stepAudioFallbackTriggeredRef.current = false;
    autoCapturedStepRef.current = '';
    if (autoCaptureTimeoutRef.current) {
      clearTimeout(autoCaptureTimeoutRef.current);
      autoCaptureTimeoutRef.current = null;
    }
    if (guidanceDebounceRef.current) {
      clearTimeout(guidanceDebounceRef.current);
      guidanceDebounceRef.current = null;
    }

    if (!isCaptureSubstateUpdate) {
      messageDisplayUntilRef.current = 0;
    }

    if (!shouldPreserveCaptureMessage) {
      setDefaultGuidanceForStep();
    }
    stepSpeechLockUntilRef.current = Date.now() + 2400;

    const shouldBlockCaptureNarration = nextStepId === 'AUTO_CAPTURE' && Date.now() < captureFeedbackLockUntilRef.current;
    if (shouldBlockCaptureNarration) {
      return () => {
        if (voiceFallbackTimer) {
          clearTimeout(voiceFallbackTimer);
        }
      };
    }

    if (isCaptureSubstateUpdate) {
      return () => {
        if (voiceFallbackTimer) {
          clearTimeout(voiceFallbackTimer);
        }
      };
    }

    if (stepData?.audio && audioRef.current) {
      // Hold dynamic guidance while the step narration audio is playing.
      stepSpeechLockUntilRef.current = Date.now() + 120000;
      audioRef.current.currentTime = 0;
      audioRef.current
        .play()
        .catch(() => {
          if (!stepAudioFallbackTriggeredRef.current) {
            stepAudioFallbackTriggeredRef.current = true;
            stepSpeechLockUntilRef.current = Date.now() + 2800;
            speak(stepData.text, { interrupt: true });
          }
        });

      voiceFallbackTimer = setTimeout(() => {
        if (stepAudioFallbackTriggeredRef.current) return;
        if (!audioRef.current || !audioRef.current.paused) return;
        stepAudioFallbackTriggeredRef.current = true;
        stepSpeechLockUntilRef.current = Date.now() + 2800;
        speak(stepData.text, { interrupt: true });
      }, 900);
    } else {
      speak(stepData.text, { interrupt: true });
    }

    return () => {
      if (voiceFallbackTimer) {
        clearTimeout(voiceFallbackTimer);
      }
    };
  }, [isVideoStep, setDefaultGuidanceForStep, speak, stepData]);

  const handleAudioError = useCallback(() => {
    if (stepAudioFallbackTriggeredRef.current) return;
    stepAudioFallbackTriggeredRef.current = true;
    stepSpeechLockUntilRef.current = Date.now() + 2800;
    speak(stepData.text, { interrupt: true });
  }, [speak, stepData.text]);

  const handleStepAudioEnded = useCallback(() => {
    stepSpeechLockUntilRef.current = 0;
  }, []);

  // El reset de guidanceStatus ahora lo maneja App.jsx
  // Este efecto solo procesa cambios de messages basados en el estado actual
  useEffect(() => {
    if (!isVideoStep || !guidanceStatus || isValidatingMatch) return;

    const isSearchingStatus = guidanceStatus === 'DOC_SEARCHING' || guidanceStatus === 'FACE_SEARCHING';
    if (isSearchingStatus) return;

    if (Date.now() < stepSpeechLockUntilRef.current) return;

    // Debounce: No procesar cambios muy rápido (esperar 150ms de estabilidad)
    if (guidanceDebounceRef.current) {
      clearTimeout(guidanceDebounceRef.current);
    }

    guidanceDebounceRef.current = setTimeout(() => {
      guidanceDebounceRef.current = null;

      // Verificar duración mínima del mensaje anterior
      const now = Date.now();
      if (now < messageDisplayUntilRef.current) return;

      const mapped = getGuidanceMessage(action, guidanceStatus, stepData?.messages);
      if (!mapped) return;

      const isAlignedStatus = guidanceStatus === 'DOC_ALIGNED' || guidanceStatus === 'FACE_ALIGNED' || guidanceStatus === 'DOC_FACE_REQUIRED';
      const displayDurationMs = isAlignedStatus ? 1800 : 1800;

      // Actualizar mensaje con una duración suficiente para que no se pise
      messageDisplayUntilRef.current = now + displayDurationMs;
      queueMicrotask(() => setAgentMessage(mapped.text));

      const spokenKey = `${action}:${guidanceStatus}`;
      if (lastSpokenStatusRef.current !== spokenKey) {
        // Pequeño delay (2ms) antes de hablar para asegurar que el texto se renderice primero
        setTimeout(() => {
          speak(mapped.voice, { interrupt: false });
        }, 2);
        lastSpokenStatusRef.current = spokenKey;
      }
    }, 150); // Debounce delay
  }, [action, guidanceStatus, isValidatingMatch, isVideoStep, speak]);

  const handleCameraReady = useCallback(() => {
    hasCameraEverBeenReadyRef.current = true;
    setCameraReady(true);
  }, []);

  useEffect(() => {
    return () => {
      if (autoCaptureTimeoutRef.current) {
        clearTimeout(autoCaptureTimeoutRef.current);
      }
      if (guidanceDebounceRef.current) {
        clearTimeout(guidanceDebounceRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const handleVideoAction = useCallback(async (forcedAutoType = null) => {
    if (!cameraStarted) {
      setCameraStarted(true);
      return false;
    }

    if (!cameraReady) return false;

    // Modo AUTO: detectar qué tipo se capturó basándose en guidanceStatus
    if (stepData?.type === 'video_auto') {
      const autoType = forcedAutoType || (guidanceStatus === 'DOC_ALIGNED' ? 'DOCUMENT' : guidanceStatus === 'FACE_ALIGNED' ? 'FACE' : null);

      if (autoType === 'DOCUMENT') {
        if (completedCaptures.DOCUMENT) return false;
        const capture = videoCanvasRef.current?.captureCurrentFrame();
        if (!capture) {
          const errorMsg = stepData?.messages?.capture?.DOCUMENT?.error || 'No pude capturar el DNI. Revisa la cámara e intentalo de nuevo.';
          if (guidanceDebounceRef.current) {
            clearTimeout(guidanceDebounceRef.current);
            guidanceDebounceRef.current = null;
          }
          messageDisplayUntilRef.current = Date.now() + 2200;
          setAgentMessage(errorMsg);
          speak(errorMsg);
          return false;
        }
        if (guidanceDebounceRef.current) {
          clearTimeout(guidanceDebounceRef.current);
          guidanceDebounceRef.current = null;
        }
        const lockUntil = Date.now() + captureFeedbackHoldMs;
        messageDisplayUntilRef.current = lockUntil;
        setCaptureUiLockUntil(lockUntil);
        captureFeedbackLockUntilRef.current = lockUntil;
        onCapturedImage?.('DOCUMENT', capture);
        const successMsg = stepData?.messages?.capture?.DOCUMENT?.success || 'DNI capturado correctamente.';
        setAgentMessage(successMsg);
        speak(successMsg);
        onDetectionType?.('DOCUMENT');
        return true;
      }
      
      if (autoType === 'FACE') {
        if (completedCaptures.FACE) return false;
        const capture = videoCanvasRef.current?.captureCurrentFrame();
        if (!capture) {
          const errorMsg = stepData?.messages?.capture?.FACE?.error || 'No pude capturar el cara. Revisa la cámara e intentalo de nuevo.';
          if (guidanceDebounceRef.current) {
            clearTimeout(guidanceDebounceRef.current);
            guidanceDebounceRef.current = null;
          }
          messageDisplayUntilRef.current = Date.now() + 2200;
          setAgentMessage(errorMsg);
          speak(errorMsg);
          return false;
        }
        if (guidanceDebounceRef.current) {
          clearTimeout(guidanceDebounceRef.current);
          guidanceDebounceRef.current = null;
        }
        const lockUntil = Date.now() + captureFeedbackHoldMs;
        messageDisplayUntilRef.current = lockUntil;
        setCaptureUiLockUntil(lockUntil);
        captureFeedbackLockUntilRef.current = lockUntil;
        onCapturedImage?.('FACE', capture);
        const successMsg = stepData?.messages?.capture?.FACE?.success || 'cara capturado correctamente.';
        setAgentMessage(successMsg);
        speak(successMsg);
        onDetectionType?.('FACE');
        return true;
      }
      
      return false;
    }

    if (action === 'face_match') {
      if (isValidatingMatch) return true;
      const baseText = (stepData.text || '').trim();
      if (baseText) {
        setAgentMessage(baseText);
        speak(baseText);
      } else {
        const validatingMsg = stepData?.messages?.validating || 'Validando identidad. Estoy comparando tu cara con la foto del DNI.';
        setAgentMessage(validatingMsg);
        speak(validatingMsg);
      }
      setIsValidatingMatch(true);
      await runFaceMatch();
      return true;
    }

    return false;
  }, [action, cameraReady, cameraStarted, completedCaptures.DOCUMENT, completedCaptures.FACE, guidanceStatus, onCapturedImage, onDetectionType, runFaceMatch, speak, stepData]);

  useEffect(() => {
    const isAutoStep = stepData?.type === 'video_auto';
    if (!isAutoStep || !cameraStarted || !cameraReady) return;

    const autoDocAligned = isAutoStep && guidanceStatus === 'DOC_ALIGNED' && !completedCaptures.DOCUMENT;
    const autoFaceAligned = isAutoStep && guidanceStatus === 'FACE_ALIGNED' && !completedCaptures.FACE;
    const shouldAutoCap = autoDocAligned || autoFaceAligned;
    if (!shouldAutoCap) return;

    const captureKey = `${stepData.id}:${guidanceStatus}`;
    if (autoCapturedStepRef.current === captureKey) return;
    if (autoCaptureTimeoutRef.current) return;

    const configuredDelay = guidanceStatus === 'FACE_ALIGNED' ? faceCaptureHoldMs : docCaptureHoldMs;
    const captureDelay = Math.max(configuredDelay, minAlignedMessageLeadMs);
    const targetType = guidanceStatus === 'FACE_ALIGNED' ? 'FACE' : 'DOCUMENT';
    const remainingMessageHoldMs = Math.max(0, messageDisplayUntilRef.current - Date.now());
    const scheduledDelay = Math.max(captureDelay, remainingMessageHoldMs);
    autoCaptureTimeoutRef.current = setTimeout(async () => {
      autoCaptureTimeoutRef.current = null;
      const didCapture = await handleVideoAction(targetType);
      if (didCapture) {
        autoCapturedStepRef.current = captureKey;
      }
    }, scheduledDelay);
  }, [
    action,
    cameraReady,
    cameraStarted,
    completedCaptures.DOCUMENT,
    completedCaptures.FACE,
    captureFeedbackHoldMs,
    docCaptureHoldMs,
    faceCaptureHoldMs,
    guidanceStatus,
    handleVideoAction,
    minAlignedMessageLeadMs,
    stepData
  ]);

  const isButtonDisabled = useMemo(() => {
    if (isTransitioning) return true;
    if (!isVideoStep) return false;
    if (!cameraStarted) return true;
    if (!cameraReady) return true;

    if (action === 'capture_auto') {
      return true;
    }

    if (action === 'face_match') {
      // Habilitar botón si: está esperando validación (IDLE), falló con fallo técnico (FAILED + captureFailure true)
      if (validationResult === 'PROCESSING') return isValidatingMatch; // Deshabilitado si está validando
      if (validationResult === 'IDLE') return false; // Habilitado para validar
      if (validationResult === 'SUCCESS') return true; // Deshabilitado pero completado
      if (validationResult === 'FAILED') {
        // Si es ataque (captureFailure === false), DESHABILITAR botón
        if (captureFailure === false) return true; // Botón deshabilitado: no permitir más intentos
        // Si es fallo técnico (captureFailure === true), HABILITAR botón
        return false; // Habilitado para reintentar
      }
      return true;
    }

    return false;
  }, [action, cameraReady, cameraStarted, isTransitioning, isValidatingMatch, isVideoStep, validationResult, captureFailure]);

  const buttonLabel = useMemo(() => {
    if (flowState === 'MENU') return 'Iniciar detección automática';

    if (action === 'capture_auto' && captureUiLockUntil > Date.now()) {
      return 'Esperando detección automática';
    }

    // --- Lógica especial para face_match independientemente del tipo de paso ---
    if (action === 'face_match') {
      if (validationResult === 'PROCESSING') return 'Validando identidad...';
      if (validationResult === 'SUCCESS') return 'Verificación completada';
      if (validationResult === 'FAILED') {
        // Si es ataque (captureFailure === false), mostrar mensaje bloqueado
        if (captureFailure === false) {
          return 'Ataque detectado';
        }
        // Si es fallo técnico (captureFailure === true), permitir reintentar
        if (stepData?.type === 'info') {
          return 'Reintentar validación';
        }
        // Si estamos en video_auto, podría ser error de captura específica
        if (agentMessage?.toLowerCase().includes('frontal')) return 'Repetir frontal';
        if (agentMessage?.toLowerCase().includes('cara')) return 'Repetir cara';
        return 'Reintentar validación';
      }
      return 'Validar capturas';
    }

    if (!isVideoStep) return 'Continuar';

    if (!cameraStarted) return 'Iniciando camara...';
    if (!cameraReady) {
      if (action === 'capture_auto' && hasCameraEverBeenReadyRef.current) {
        return 'Esperando detección automática';
      }
      return 'Cargando camara...';
    }

    if (action === 'capture_auto') {
      return 'Esperando detección automática';
    }

    return 'Continuar';
  }, [action, agentMessage, cameraReady, cameraStarted, captureUiLockUntil, flowState, isVideoStep, validationResult, captureFailure, stepData?.type]);

  // Ejecutar validación biométrica automáticamente en 6 segundos si el usuario no pulsa el botón
  useEffect(() => {
    if (action === 'face_match' && stepData.type === 'info') {
      // Limpiar timeout anterior si existe
      if (autoValidationTimeoutRef.current) {
        clearTimeout(autoValidationTimeoutRef.current);
      }
      
      // Establecer timeout de 8 segundos para auto-validar
      autoValidationTimeoutRef.current = setTimeout(() => {
        setIsValidatingMatch(true);
        runFaceMatch();
      }, 8000);
    }
    
    return () => {
      if (autoValidationTimeoutRef.current) {
        clearTimeout(autoValidationTimeoutRef.current);
      }
    };
    // Solo una vez al entrar en el paso
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, stepData.type]);

  // Actualizar agentMessage cuando termina la validación (cuando agentMatchingMessage cambia)
  useEffect(() => {
    if (!isValidatingMatch && agentMatchingMessage && action === 'face_match') {
      // Si la validación fue exitosa, ir directamente al siguiente paso sin mostrar el mensaje
      if (validationResult === 'SUCCESS') {
        onValidationComplete?.('SUCCESS');
      } else {
        // Si falló, mostrar el mensaje de error
        setAgentMessage(agentMatchingMessage);
      }
    }
  }, [agentMatchingMessage, isValidatingMatch, validationResult, action, onValidationComplete]);

  const handlePrimaryAction = useCallback(async () => {
    // BLOQUEO ABSOLUTO: Si es face_match, solo se puede avanzar con SUCCESS
    if (action === 'face_match') {
      if (validationResult === 'SUCCESS') {
        return;
      }

      if (validationResult === 'FAILED') {
        // Diferenciamos entre fallo técnico (reintentar) y ataque (bloquear)
        if (captureFailure === false) {
          // ⚠️ ATAQUE DETECTADO: Datos válidos pero NO coinciden
          // No permitir reintentar indefinidamente
          setAgentMessage(
            agentMatchingMessage || 
            'Ataque detectado. Los datos no coinciden con la identidad esperada.'
          );
          return;
        }
        // Si es true (fallo técnico) o null, permitir reintentar
      }

      if (validationResult === 'FAILED' || validationResult === 'IDLE' || validationResult === 'PROCESSING') {
        // Limpiar timeout de auto-validación si está activo
        if (autoValidationTimeoutRef.current) {
          clearTimeout(autoValidationTimeoutRef.current);
          autoValidationTimeoutRef.current = null;
        }
        
        setValidationResult('PROCESSING');
        setIsValidatingMatch(true);
        await runFaceMatch();
        return;
      }
      return;
    }

    if (isVideoStep) {
      await handleVideoAction();
      return;
    }

    // Any non-video button click is a valid user gesture to unlock audio.
    if (!isVideoStep) {
      unlockAudioByGesture();
    }

    onStepComplete();
  }, [handleVideoAction, isVideoStep, onStepComplete, unlockAudioByGesture, action, validationResult, runFaceMatch, captureFailure, agentMatchingMessage]);

  useEffect(() => {
    if (action !== 'capture_auto') return;
    if (!stepData?.text) return;

    const completedCount = Number(Boolean(completedCaptures.DOCUMENT)) + Number(Boolean(completedCaptures.FACE));
    if (completedCount !== 1) return;

    const messageKey = `${stepData.text}:${completedCaptures.DOCUMENT ? 'D' : 'F'}`;
    if (lastPostCapturePromptKeyRef.current === messageKey) return;

    const lockRemainingMs = Math.max(0, captureUiLockUntil - Date.now());
    const timeoutId = setTimeout(() => {
      if (lastPostCapturePromptKeyRef.current === messageKey) return;
      lastPostCapturePromptKeyRef.current = messageKey;
      setAgentMessage(stepData.text);
      speak(stepData.text, { interrupt: false });
    }, lockRemainingMs + 40);

    return () => clearTimeout(timeoutId);
  }, [
    action,
    captureUiLockUntil,
    completedCaptures.DOCUMENT,
    completedCaptures.FACE,
    speak,
    stepData?.text
  ]);

  return (
    <div className="agente-wrapper">
      <div className="agente-mensaje">
        <p>{agentMessage}</p>
      </div>

      {stepData?.infoSection && (
        <div className="agente-info-section">
          {stepData.infoSection.title && (
            <h2 className="info-section-title">{stepData.infoSection.title}</h2>
          )}
          {stepData.infoSection.cards && (
            <div className="info-cards-container">
              {stepData.infoSection.cards.map((card) => (
                <div key={card.id} className="info-card glass-effect">
                  <div className="info-card-icon">
                    <span className="material-symbols-outlined">{card.icon}</span>
                  </div>
                  <h3 className="info-card-label">{card.label}</h3>
                  {card.description && (
                    <p className="info-card-description">{card.description}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {action === 'face_match' && stepData.type === 'info' && (
        <div className="agente-info-section">
          <h2 className="info-section-title">Verifica tus capturas</h2>
          <div className="info-cards-container">
            {capturedImages.DOCUMENT && (
              <div className="info-card glass-effect">
                <div className="info-card-icon">
                  <img src={capturedImages.DOCUMENT} alt="DNI capturado" className="validation-capture-image" />
                </div>
                <h3 className="info-card-label">Foto de tu DNI</h3>
                <button 
                  className="recapture-button" 
                  onClick={() => onRecaptureType?.('DOCUMENT')}
                  disabled={isTransitioning || (action === 'face_match' && validationResult === 'FAILED' && captureFailure === false)}
                  title="Recapturar DNI"
                >
                  <span className="material-symbols-outlined">refresh</span>
                  Recapturar
                </button>
              </div>
            )}
            {capturedImages.FACE && (
              <div className="info-card glass-effect">
                <div className="info-card-icon">
                  <img src={capturedImages.FACE} alt="cara capturado" className="validation-capture-image" />
                </div>
                <h3 className="info-card-label">Foto de tu cara</h3>
                <button 
                  className="recapture-button" 
                  onClick={() => onRecaptureType?.('FACE')}
                  disabled={isTransitioning || (action === 'face_match' && validationResult === 'FAILED' && captureFailure === false)}
                  title="Recapturar cara"
                >
                  <span className="material-symbols-outlined">refresh</span>
                  Recapturar
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <audio ref={audioRef} src={stepData?.audio} onError={handleAudioError} onEnded={handleStepAudioEnded} />

        {isVideoStep && (
          <div className="agente-video">
            <VideoCanvas
              ref={videoCanvasRef}
              onCameraReady={handleCameraReady}
              onGuidanceStatusChange={onGuidanceStatusChange}
              startCamera={cameraStarted}
              detectionConfig={effectiveDetectionConfig}
            />
        </div>
      )}

      <div className="agente-actions">
        {isValidatingMatch ? (
          <div className="agente-spinner" aria-label="Validando identidad">
            <span className="spinner" />
          </div>
        ) : (validationResult === 'SUCCESS' && action === 'face_match') ? null : (
          <button
            onClick={handlePrimaryAction}
            disabled={isButtonDisabled}
            className="glass-button agente-button"
          >
            {buttonLabel}
          </button>
        )}
      </div>

      {(flowState === 'MENU' || flowState === 'CAPTURING') && (
        <div className="capture-checklist" aria-label="Estado de capturas">
          {[
            { id: 'DOCUMENT', label: 'DNI', icon: 'document' },
            { id: 'FACE', label: 'cara', icon: 'face' }
          ].map((capture) => {
            const isDone = Boolean(completedCaptures[capture.id]);
            const previewSrc = capturedImages[capture.id] || null;

            return (
              <div
                key={capture.id}
                className={`capture-checklist-item ${isDone ? 'is-done' : ''}`}
              >
                <span className="capture-checklist-mark" aria-hidden="true">{isDone ? '✓' : '○'}</span>
                <div className="capture-checklist-content">
                  <span className="capture-checklist-label">Captura de tu {capture.label}</span>
                  {isDone ? (
                    <span className="capture-checklist-status">capturado</span>
                  ) : (
                    <span className="capture-checklist-status pending">pendiente</span>
                  )}
                </div>
                {previewSrc && (
                  <img
                    className="capture-checklist-thumb"
                    src={previewSrc}
                    alt={`Captura de ${capture.label.toLowerCase()}`}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default Agente;