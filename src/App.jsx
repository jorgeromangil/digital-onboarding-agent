import { useState, useMemo, useEffect, useRef } from 'react';
import onboardingFlow from './data/onboardingFlow.json';
import Agente from './components/Agente';
import { usePersistentCapturedImages } from './hooks/usePersistentCapturedImages';
import './App.css';

function App() {
  const CAPTURE_FEEDBACK_HOLD_MS = 1400;

  // Estado del orquestador: 'WELCOME' | 'MENU' | 'CAPTURING' | 'VALIDATING' | 'FINISH'
  const [flowState, setFlowState] = useState('WELCOME');
  
  // Qué capturas se han completado
  const [completedCaptures, setCompletedCaptures] = useState({
    DOCUMENT: false,
    FACE: false
  });

  // Mapeo de estados a pasos del flujo
  const flowSteps = [
    { state: 'WELCOME', label: 'Bienvenida', progress: 13.5 },
    { state: 'MENU', label: 'Introducción', progress: 37.5 },
    { state: 'CAPTURING', label: 'Captura', progress: 62 },
    { state: 'VALIDATING', label: 'Validación', progress: 86 },
    { state: 'FINISH', label: 'Finalización', progress: 100 }
  ];

  // Obtener el índice del paso actual
  const currentStepIndex = flowSteps.findIndex(step => step.state === flowState);
  const currentStepNumber = currentStepIndex + 1;
  const currentProgress = flowSteps[currentStepIndex]?.progress || 0;
  const currentStepLabel = flowSteps[currentStepIndex]?.label || 'Proceso';
  
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [guidanceStatus, setGuidanceStatus] = useState('SEARCHING');
  const [isMuted, setIsMuted] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [recaptureType, setRecaptureType] = useState(null); // 'DOCUMENT' | 'FACE' | null
  const validationTransitionTimeoutRef = useRef(null);
  
  // Usar hook para persistencia de imágenes capturadas
  const { capturedImages, setCapturedImages, clearFromStorage } = usePersistentCapturedImages();

  // Sincronizar completedCaptures con las imágenes guardadas en localStorage
  useEffect(() => {
    const newCompletedCaptures = {
      DOCUMENT: !!capturedImages.DOCUMENT,
      FACE: !!capturedImages.FACE
    };
    
    // Solo actualizar si hay cambios
    if (newCompletedCaptures.DOCUMENT !== completedCaptures.DOCUMENT || 
        newCompletedCaptures.FACE !== completedCaptures.FACE) {
      setCompletedCaptures(newCompletedCaptures);
    }
  }, [capturedImages]);

  // Si es la primer carga y hay 2 capturas guardadas, ir directamente a VALIDATING
  // (significa que la validación anterior falló)
  useEffect(() => {
    if (isInitialLoad && capturedImages.DOCUMENT && capturedImages.FACE) {
      setFlowState('VALIDATING');
      setIsInitialLoad(false);
    } else if (isInitialLoad) {
      setIsInitialLoad(false);
    }
  }, []);

  // Resetear guidanceStatus cuando completedCaptures cambia en CAPTURING
  // Asegurar que siempre refleja qué falta capturar
  useEffect(() => {
    if (flowState !== 'CAPTURING') return;

    const needsDocument = !completedCaptures.DOCUMENT;
    const needsFace = !completedCaptures.FACE;

    if (!needsDocument && !needsFace) {
      return;
    }

    let newStatus = 'SEARCHING';
    if (needsDocument && !needsFace) {
      newStatus = 'DOC_SEARCHING';
    } else if (needsFace && !needsDocument) {
      newStatus = 'FACE_SEARCHING';
    }

    setGuidanceStatus(newStatus);
  }, [completedCaptures, flowState]);

  useEffect(() => {
    return () => {
      if (validationTransitionTimeoutRef.current) {
        clearTimeout(validationTransitionTimeoutRef.current);
      }
    };
  }, []);

  const advanceToNextStep = (nextState) => {
    setIsTransitioning(true);
    setTimeout(() => {
      setFlowState(nextState);
      setIsTransitioning(false);
    }, 300);
  };

  // Interpretador genérico del flujo
  const getNextState = (currentState, contextData = {}) => {
    const flowDef = onboardingFlow.flowDefinition?.find(def => def.id === currentState);
    if (!flowDef) return null;

    const { allCapturesComplete, validationSuccess } = contextData;

    if (flowDef.nextCondition === 'always') return flowDef.next;
    if (flowDef.nextCondition === 'allCapturesComplete' && allCapturesComplete) return flowDef.next;
    if (flowDef.nextCondition === 'validationSuccess' && validationSuccess) return flowDef.next;

    return null; // Condición no cumplida
  };

  // Obtener capturas pendientes
  const pendingCaptures = useMemo(() => {
    return onboardingFlow.captures.filter(capture => !completedCaptures[capture.id]);
  }, [completedCaptures]);

  // En modo AUTO, mostramos la intro de captura inteligente
  const currentStep = useMemo(() => {
    if (flowState === 'WELCOME') {
      return onboardingFlow.globalSteps.WELCOME;
    }

    if (flowState === 'MENU') {
      return onboardingFlow.globalSteps.MENU;
    }

    if (flowState === 'VALIDATING') {
      return onboardingFlow.globalSteps.VALIDATING;
    }

    if (flowState === 'FINISH') {
      return onboardingFlow.globalSteps.FINISH;
    }
    
    const completedCount = Object.values(completedCaptures).filter(Boolean).length;
    const totalCount = onboardingFlow.captures.length;
    const remainingCapture = pendingCaptures[0] || null;
    const remainingLabel = remainingCapture?.label || 'pendiente';
    
    const capturingStep = onboardingFlow.globalSteps.CAPTURING || {};
    const capturingMessages = capturingStep.messages || {};
    
    let guidanceText;
    if (pendingCaptures.length === totalCount) {
      guidanceText = capturingMessages.firstCapture || 'Muestra primero tu documento o tu rostro, en el orden que prefieras.';
    } else if (pendingCaptures.length === 0) {
      guidanceText = '';
    } else if (pendingCaptures.length === 1) {
      const baseMsg = capturingMessages.oneRemaining || 'Perfecto. Ahora muestra tu {remaining}.';
      guidanceText = baseMsg.replace('{remaining}', remainingLabel);
    } else {
      guidanceText = capturingMessages.multipleRemaining || 'Sigue mostrando documento o rostro para completar la verificación.';
    }

    if (flowState === 'CAPTURING') {
      const configuredCapturingStep = onboardingFlow.globalSteps.CAPTURING || {};
      const introText = configuredCapturingStep.text || '';
      const stepText = [
        introText,
        guidanceText
      ].filter(Boolean).join(' ');

      return {
        id: configuredCapturingStep.id || 'AUTO_CAPTURE',
        type: configuredCapturingStep.type || 'video_auto',
        action: configuredCapturingStep.action || 'capture_auto',
        detection: configuredCapturingStep.detection,
        messages: configuredCapturingStep.messages,
        text: stepText
      };
    }
    
    return null;
  }, [completedCaptures, flowState, pendingCaptures]);

  const handleNext = () => {
    if (isTransitioning) return;

    // Contexto para evaluar condiciones del flujo
    const contextData = {
      allCapturesComplete: pendingCaptures.length === 0,
      validationSuccess: false // Se establece en handleValidationComplete
    };

    const nextState = getNextState(flowState, contextData);
    
    if (nextState) {
      advanceToNextStep(nextState);
    } else if (flowState === 'FINISH') {
      // Lógica especial para finalización
      const finishStep = onboardingFlow.globalSteps.FINISH || {};
      const completionMsg = finishStep.messages?.completion || 'Proceso de Onboarding finalizado con éxito.';
      alert(completionMsg);
      clearFromStorage();
    }
  };

  const handleValidationComplete = (result) => {
    if (result !== 'SUCCESS' || isTransitioning) return;
    
    // Usar el interpretador genérico para VALIDATING → FINISH
    const contextData = { validationSuccess: true };
    const nextState = getNextState('VALIDATING', contextData);
    
    if (nextState) {
      advanceToNextStep(nextState);
    }
  };

  const handleCapturedImage = (captureType, imageDataUrl) => {
    if (!captureType || !imageDataUrl) return;
    setCapturedImages((prev) => ({
      ...prev,
      [captureType]: imageDataUrl
    }));
  };

  // Handler para recapturar un tipo específico (p.ej., cuando la validación falla)
  const handleRecaptureType = (captureType) => {
    if (!captureType) return;
    // Borrar solo ese tipo de captura y volver a CAPTURING
    setCapturedImages((prev) => ({
      ...prev,
      [captureType]: null
    }));
    setRecaptureType(captureType);
    advanceToNextStep('CAPTURING');
  };

  // Manejador para cuando se detecta automáticamente un tipo
  const handleDetectionType = (detectionType) => {
    if (flowState !== 'CAPTURING') return;

    const alreadyCompleted = Boolean(completedCaptures[detectionType]);
    if (alreadyCompleted) return;

    const nextCompleted = {
      ...completedCaptures,
      [detectionType]: true
    };
    const didCompleteAll = onboardingFlow.captures.every((capture) => nextCompleted[capture.id]);

    setCompletedCaptures((prev) => {
      if (prev[detectionType]) return prev;

      return {
        ...prev,
        [detectionType]: true
      };
    });

    if (didCompleteAll && !isTransitioning) {
      if (validationTransitionTimeoutRef.current) {
        clearTimeout(validationTransitionTimeoutRef.current);
      }

      validationTransitionTimeoutRef.current = setTimeout(() => {
        validationTransitionTimeoutRef.current = null;
        advanceToNextStep('VALIDATING');
      }, CAPTURE_FEEDBACK_HOLD_MS);
    }
  };

  return (
    <div className="App app-shell">
      <header className="app-header">
        <h1>{onboardingFlow.onboarding_id || "Aamerly"}</h1>
        <button
          className="mute-button"
          onClick={() => setIsMuted(!isMuted)}
          title={isMuted ? 'Activar sonido' : 'Mutear sonido'}
          aria-label={isMuted ? 'Activar sonido' : 'Mutear sonido'}
        >
          <span className="material-symbols-outlined">
            {isMuted ? 'volume_off' : 'volume_up'}
          </span>
        </button>
      </header>

      <div className="app-card glass-effect">
        <main>
          <div className={`step-transition ${isTransitioning ? 'step-transition--out' : 'step-transition--in'}`}>
            <Agente 
              stepData={currentStep} 
              onStepComplete={handleNext}
              onValidationComplete={handleValidationComplete}
              onDetectionType={handleDetectionType}
              onRecaptureType={handleRecaptureType}
              flowState={flowState}
              completedCaptures={completedCaptures}
              isTransitioning={isTransitioning}
              guidanceStatus={guidanceStatus}
              onGuidanceStatusChange={setGuidanceStatus}
              onCapturedImage={handleCapturedImage}
              capturedImages={capturedImages}
              isMuted={isMuted}
            />
          </div>
        </main>
      </div>

      {/* Barra de progreso: progreso global del flujo */}
      <div className="progress-section">
        <progress
          className="app-progress"
          value={currentProgress}
          max={100}
        />
        
        <div className="progress-steps">
          {flowSteps.map((step, index) => (
            <div
              key={step.state}
              className={`progress-step ${
                index + 1 < currentStepNumber ? 'completed' : 
                index + 1 === currentStepNumber ? 'active' : 
                'pending'
              }`}
              title={step.label}
            >
              <span className="step-circle">
                {index + 1 < currentStepNumber ? '✓' : index + 1}
              </span>
            </div>
          ))}
        </div>
        
        <footer className="app-footer">
          Paso {currentStepNumber}: {currentStepLabel}
        </footer>
      </div>
    </div>
  );
}

export default App;