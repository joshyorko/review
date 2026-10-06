export interface ProbeCaseWindow {
	case: string;
	finished: boolean;
	postCount: number;
	untaggedPostCount: number;
	markerMismatchPostCount: number;
}
export interface ProbeAccountingSnapshot {
	activeCase: string | null;
	totalPostCount: number;
	assignedPostCount: number;
	unassignedPostCount: number;
	caseWindows: ProbeCaseWindow[];
}
export function completePostAccounting(snapshot: ProbeAccountingSnapshot, expectedCases: readonly string[]): boolean;
export function abortPostFinding(abortCalled: boolean, abortWindow: ProbeCaseWindow | undefined, accountingComplete: boolean, markerAttributionComplete: boolean): {
	zeroSendObserved: boolean;
	sendObserved: boolean;
	postCount: number | null;
	untaggedPostCount: number | null;
	markerMismatchPostCount: number | null;
};
export function validateAttestationFileStat(stat: { isFile: boolean; nlink: number; mode: number }): void;
export function cooperativeIdentityProblems(attestation: unknown, measured: unknown): string[];
export function validateCooperativeIdentityInput(attestation: unknown, measured: unknown): {
	attester: string;
	imageDigest: string;
	containerConfigDigest: string;
	runtime: string;
	effectiveUid: number;
	ompBinaryPath: string;
	ompVersion: string;
	ompSourceCommit: string;
	ompBinarySha256: string;
	cooperativeEvidenceFileSha256: string;
};
