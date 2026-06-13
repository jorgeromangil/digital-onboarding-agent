import { useEffect, useState } from 'react';

const STORAGE_KEY = 'agente-onboarding-captured-images';

/**
 * Hook personalizado para persistir imágenes capturadas
 * Guarda/carga las imágenes en localStorage para evitar pérdida de datos en refresh
 */
export const usePersistentCapturedImages = () => {
  const [capturedImages, setCapturedImages] = useState(() => {
    // Intentar cargar desde localStorage al iniciar
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.warn('Error loading captured images from localStorage:', e);
    }
    
    // Valor por defecto si no hay nada en localStorage
    return {
      DOCUMENT: null,
      FACE: null
    };
  });

  // Guardar en localStorage cada vez que cambien las imágenes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(capturedImages));
    } catch (e) {
      console.warn('Error saving captured images to localStorage:', e);
    }
  }, [capturedImages]);

  // Función para limpiar desde localStorage (llamar después de completar onboarding)
  const clearFromStorage = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.warn('Error clearing captured images from localStorage:', e);
    }
  };

  return {
    capturedImages,
    setCapturedImages,
    clearFromStorage
  };
};
