import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { HermeticError } from "../errors.ts";
import { UBUNTU_RELEASE } from "../backend/constants.ts";
import { asHermeticError } from "./client.ts";

/**
 * The fleet boots one pinned stock image until it is deliberately bumped (§6.2
 * step 7), so this is resolved once at `init` and again on `upgrade`, never per
 * create. Canonical publishes the id as a public SSM parameter.
 */
export const UBUNTU_AMI_PARAMETER =
  "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id";

export { UBUNTU_RELEASE };

export async function resolveUbuntuAmi(ssm: SSMClient, region: string): Promise<string> {
  let value: string | undefined;
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: UBUNTU_AMI_PARAMETER }));
    value = out.Parameter?.Value;
  } catch (e) {
    throw asHermeticError(e, `could not resolve the Ubuntu ${UBUNTU_RELEASE} arm64 AMI in ${region}`);
  }
  if (!value || !/^ami-[0-9a-f]{8,17}$/.test(value)) {
    throw new HermeticError(
      "INTERNAL",
      `${UBUNTU_AMI_PARAMETER} in ${region} did not resolve to an AMI id`,
      { region, value: value ?? null },
    );
  }
  return value;
}
