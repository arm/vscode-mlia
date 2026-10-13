import type { MliaAnalysisMode } from "./pythonRuntime";

export const acceptedEulasSetting = "acceptedEulas";
export type EulaAcceptances = Record<string, string>;

export interface EulaDefinition {
  id: string;
  title: string;
  packageName: string;
  pythonModule: string;
  pythonProperty: string;
}

export interface EulaAgreement {
  definition: EulaDefinition;
  text: string;
  packageVersion: string;
}

export type EulaDecision = { proceed: false } | { proceed: true; acceptEula: boolean };

const gcpe: EulaDefinition = {
  id: "arm-gcpe",
  title: "Arm Graph Compiler Performance Estimator",
  packageName: "mlia-neural-technology",
  pythonModule: "mlia.backend.nx_performance_estimator.installer",
  pythonProperty: "DEFAULT_LICENSE_FILE",
};

// Only these named profiles in estimation mode use the mapped GCPE EULA.
// Unmapped combinations receive no automatic acceptance; MLIA enforces any
// outstanding requirements through its noninteractive checks.
const requirements = new Map<string, EulaDefinition>([
  [JSON.stringify(["neural-technology", "estimation"]), gcpe],
  [JSON.stringify(["NX-peak-12SC-8NX-600MHz", "estimation"]), gcpe],
  [JSON.stringify(["NX-sustained-12SC-8NX-350MHz", "estimation"]), gcpe],
]);

export function requiredEula(targetProfile: string, mode: MliaAnalysisMode): EulaDefinition | undefined {
  return requirements.get(JSON.stringify([targetProfile, mode]));
}

export interface EulaAcceptanceOptions {
  readAcceptances: () => unknown;
  writeAcceptances: (acceptances: EulaAcceptances) => PromiseLike<void>;
  getPackageVersion: (packageName: string) => string | undefined;
  loadText: (definition: EulaDefinition, packageVersion: string) => Promise<string>;
  prompt: (agreement: EulaAgreement) => Promise<boolean>;
  now?: () => Date;
}

/** Stores explicit consent by agreement identity and its providing package version. */
export class EulaAcceptanceManager {
  private readonly pending = new Map<string, Promise<boolean>>();
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: EulaAcceptanceOptions) {}

  public async authorize(targetProfile: string, mode: MliaAnalysisMode): Promise<EulaDecision> {
    const definition = requiredEula(targetProfile, mode);
    if (!definition) {
      return { proceed: true, acceptEula: false };
    }
    const packageVersion = this.options.getPackageVersion(definition.packageName);
    if (!packageVersion?.trim()) {
      throw new Error(`The cached version of ${definition.packageName} is unavailable. Refresh MLIA Environment and try again.`);
    }
    const key = `${definition.id}:${packageVersion}`;
    const acceptedAt = this.readAcceptances()[key];
    if (typeof acceptedAt === "string" && Number.isFinite(Date.parse(acceptedAt))) {
      return { proceed: true, acceptEula: true };
    }

    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.requestAcceptance(key, definition, packageVersion);
      this.pending.set(key, pending);
    }
    try {
      return await pending ? { proceed: true, acceptEula: true } : { proceed: false };
    } finally {
      if (this.pending.get(key) === pending) {
        this.pending.delete(key);
      }
    }
  }

  private readAcceptances(): EulaAcceptances {
    const value = this.options.readAcceptances();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ));
  }

  private checkVersion(definition: EulaDefinition, packageVersion: string): void {
    if (this.options.getPackageVersion(definition.packageName) !== packageVersion) {
      throw new Error("The MLIA environment changed while reviewing the EULA. Run the analysis again.");
    }
  }

  private async requestAcceptance(key: string, definition: EulaDefinition, packageVersion: string): Promise<boolean> {
    const text = await this.options.loadText(definition, packageVersion);
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`The EULA for ${definition.title} is empty or unreadable.`);
    }
    this.checkVersion(definition, packageVersion);
    if (!(await this.options.prompt({ definition, text, packageVersion }))) {
      return false;
    }
    // Read the latest setting inside the write queue so simultaneous consent
    // decisions merge rather than replacing each other's entries.
    const write = this.writeTail.then(() => {
      this.checkVersion(definition, packageVersion);
      return this.options.writeAcceptances({
        ...this.readAcceptances(),
        [key]: (this.options.now?.() ?? new Date()).toISOString(),
      });
    });
    this.writeTail = write.catch(() => undefined);
    await write;
    this.checkVersion(definition, packageVersion);
    return true;
  }
}
