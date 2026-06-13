# Digital Onboarding Agent

## Description

<img width="3840" height="2160" alt="description" src="https://github.com/user-attachments/assets/4cd962f2-5b29-4c43-962c-d60e20655778" />


Web application developed as a prototype of an automated digital onboarding agent, designed to optimize the verification and identification process for new users. The system implements biometric validation through facial recognition and identity document detection, enabling a flexible and proactive experience that reduces drop-off rates in KYC (Know Your Customer) processes.

Unlike traditional approaches with rigid sequential flows, this agent enables intuitive real-time interaction: users can present either their face or identity document interchangeably, while the system automatically detects and processes the captures.

## Key Features

<img width="3840" height="2160" alt="features" src="https://github.com/user-attachments/assets/916c235f-6737-4025-82fa-74bc9899bbd1" />


✨ **Automatic Document Detection** - Intelligent capture of identity documents using computer vision

👤 **Facial Recognition** - Biometric facial analysis for identity validation

🔄 **Flexible AI-Driven Flow** - Dynamic flow orchestration configured via JSON, adaptable to context

⏱️ **Real-Time Capture** - Automatic processing of biometric data without manual intervention

🎯 **State Machine** - Data-driven architecture that adapts the flow based on user actions

## Technologies

- **Frontend:** React + Vite
- **Document Detection:** [Scanic](https://github.com/marquaye/scanic) - automatic document detection
- **Facial Recognition:** [face-api.js](https://github.com/justadudewhohacks/face-api.js) - facial analysis based on TensorFlow.js
- **Flow Configuration:** JSON + Custom state machine
- **Biometric Modeling:** Based on 128-dimensional facial descriptor

## Installation

```bash
# Clone the repository
git clone https://github.com/jorgeromangil/digital-onboarding-agent.git
cd digital-onboarding-agent

# Install dependencies
npm install

# Run in development
npm run dev

# Build for production
npm run build
```

## Project Structure

```
src/
├── components/
│   ├── Agente.jsx                 # Main agent component
│   ├── VideoCanvas.jsx            # Canvas for video capture
│   └── detection/
│       ├── faceDetection.js       # Facial recognition logic
│       ├── documentDetection.js   # Document detection logic
│       └── frameMetrics.js        # Frame metrics
├── hooks/
│   ├── useFaceMatching.js         # Hook for biometric comparison
│   └── usePersistentCapturedImages.js
├── utils/
│   └── modelLoader.js             # TensorFlow model loader
└── data/
    └── onboardingFlow.json        # Flow configuration
```

## Usage

1. Access the application in your browser
2. The agent will automatically guide the verification process
3. Capture your face and/or identity document as instructed
4. The system will validate the correspondence between biometric data

## Available Commands

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build the project for production
- `npm run preview` - Preview production build locally
- `npm run lint` - Run ESLint to check code quality

## ⚠️ DISCLAIMER - Academic Research Project

**This is an academic research project developed as a Final Degree Project (TFG). It is not intended for production use.**

### Important Limitations:

- 🔓 **Security:** This prototype does NOT implement professional-level security measures required for production systems (end-to-end encryption, advanced spoofing protection, biometric certification, etc.)

- 👤 **Privacy:** Biometric data is processed locally in the browser, but this system does NOT comply with regulations such as GDPR, CCPA, or other data protection legislation

- 🔐 **Biometric Validation:** The algorithms used are academic demonstrations and should NOT be considered robust enough for real transactions or regulatory compliance (KYC)

- ⚙️ **Reliability:** This system is an experimental prototype. Its consistent operation across all scenarios is not guaranteed

- 📋 **Regulatory Compliance:** This project does NOT comply with regulations such as PLDFT, AML (Anti-Money Laundering) standards, or certification requirements in financial or identification systems

### Recommendations:

- ✅ Use only for educational and research purposes
- ✅ Do not process real user data without explicit consent
- ✅ For production applications, consult certified third-party solutions
- ✅ Conduct professional security audits before any deployment

## Results and Findings

This project demonstrates that flow flexibility and capture automation can significantly improve:

- 📉 Reduction of drop-off rates in onboarding processes
- 🎯 Better user experience through proactive interaction
- ⚡ Real-time processing of biometric validations
- 🔄 Adaptability to different scenarios and use contexts

## Author

Jorge Román - Final Degree Project (TFG)

## License

This project is open source for academic and educational purposes only.

---

**Last updated:** June 2026
