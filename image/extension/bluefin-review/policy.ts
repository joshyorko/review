export interface ManagedRepoPolicy {
	readonly repository: string;
	readonly requiredLabels: readonly string[];
	readonly deniedLabels: readonly string[];
}

export interface WorkbenchPolicy {
	readonly managedRepositories: readonly ManagedRepoPolicy[];
	/** Permit workflow-file PR mutations only for an explicitly opted-in surface. */
	readonly allowWorkflowSlay?: boolean;
}

export const GENERIC_WORKBENCH_POLICY: WorkbenchPolicy = {
	managedRepositories: [],
	allowWorkflowSlay: true,
};


export function managedPolicyFor(repo: string, policy: WorkbenchPolicy): ManagedRepoPolicy | undefined {
	return policy.managedRepositories.find((candidate) => candidate.repository === repo);
}
