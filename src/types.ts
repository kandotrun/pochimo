export type CaptureEvent = {
  time: string;
  file: string;
  motionScore: number;
  cameraLabel: string;
  note: string;
};

export type Observation = {
  enabled: boolean;
  provider?: 'ollama-cloud' | 'local-ollama';
  model?: string;
  framesAnalyzed?: number;
  raw?: string;
  petVisible?: boolean | null;
  scene?: string;
  petActivity?: string;
  concerns?: string[];
  ownerChecks?: string[];
  summary?: string;
};

export type Report = {
  date: string;
  capturedFrames: number;
  activeFrames: number;
  topActiveHours: Array<{ hour: string; count: number }>;
  quietPeriods: Array<{ from: string; to: string }>;
  ai: Observation;
  cloud?: {
    enabled: boolean;
    model?: string;
    summary: string;
  };
  summary: string;
  nextChecks: string[];
};

export type CloudPolishResult = {
  enabled: boolean;
  model?: string;
  markdown: string;
  summary?: string;
};
