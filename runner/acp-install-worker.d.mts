export function stageAcpSource(source: string, target?: string): string;

export interface BuildPythonAcpOptions {
  root?: string;
  product: string;
  version: string;
  sourceDir: string;
  presetFile?: string;
  pythonExecutable?: string;
  uvExecutable?: string;
  offline?: boolean;
}

export function buildPythonAcpProduct(options: BuildPythonAcpOptions): unknown;
