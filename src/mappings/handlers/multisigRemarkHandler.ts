import { SubstrateExtrinsic } from "@subql/types";
import { checkAndGetAccount } from "../../utils/checkAndGetAccount";
import { checkAndGetAccountMultisig } from "../../utils/checkAndGetAccountMultisig";
import { decodeAddress, createKeyMultiAddress } from "../../utils";
import { u8aToHex } from "@polkadot/util";
import { MultisigRemarkArgs } from "../types";
import { validateAddress } from "../../utils/validateAddress";
import { isJsonStringArgs } from "../../utils/isJson";
import { CreateCallVisitorBuilder, CreateCallWalk, VisitedCall } from "subquery-call-visitor";
import { Bytes } from "@polkadot/types";

export async function handleRemark(extrinsic: SubstrateExtrinsic) {
  callWalk.walk(extrinsic, multisigVisitor);
}

const callWalk = CreateCallWalk();
const multisigVisitor = CreateCallVisitorBuilder()
  .on("utility", ["batch", "batchAll", "forceBatch"], (extrinsic, context) => {
    const calls = extrinsic.call.args.at(0);
    if (Array.isArray(calls) && calls.length > 10) {
      // we're skipping large batches, something terrible happens inside anyway
      context.stop();
    }
  })
  .on("system", "remark", handleMultisigRemarkCall)
  .ignoreFailedCalls(true)
  .build();

async function handleMultisigRemarkCall(call: VisitedCall): Promise<void> {
  if (!call || !call.call || !call.call.args) {
    return;
  }

  if (!isJsonStringArgs(call.call.args as Bytes[])) {
    return;
  }

  const args = call.call.args[0]?.toHuman() as unknown as string;

  let parsedArgs: MultisigRemarkArgs;
  try {
    parsedArgs = JSON.parse(args) as unknown as MultisigRemarkArgs;
  } catch (e) {
    return;
  }

  if (!parsedArgs) {
    logger.error(`Invalid parsed args: ${JSON.stringify(parsedArgs)}`);
    return;
  }
  if (!parsedArgs.signatories || !Array.isArray(parsedArgs.signatories) || parsedArgs.signatories.length === 0) {
    logger.error(`Invalid signatories: ${JSON.stringify(parsedArgs.signatories)}`);
    return;
  }

  if (typeof parsedArgs.threshold !== "number" || parsedArgs.threshold < 1) {
    logger.error(`Invalid threshold: ${parsedArgs.threshold}`);
    return;
  }

  for (const signatory of parsedArgs.signatories) {
    if (!validateAddress(signatory)) {
      logger.error(`Invalid signatory address: ${signatory}`);
      return;
    }
  }

  if (parsedArgs.threshold > parsedArgs.signatories.length) {
    logger.error(`Threshold is greater than the number of signatories: ${parsedArgs.threshold} > ${parsedArgs.signatories.length}`);
    return;
  }

  logger.info(`Multisig Remark Event: ${JSON.stringify(parsedArgs)}`);

  const signatoriesAccountsPromises = parsedArgs.signatories.map(signatory => checkAndGetAccount(u8aToHex(decodeAddress(signatory))));

  const allSignatoriesAccounts = await Promise.all(signatoriesAccountsPromises);

  logger.info(`Signatories Accounts: ${JSON.stringify(allSignatoriesAccounts)}`);

  const multisigAddress = createKeyMultiAddress(parsedArgs.signatories, parsedArgs.threshold);

  const multisigPubKey = u8aToHex(decodeAddress(multisigAddress));

  const multisigAccount = await checkAndGetAccount(multisigPubKey, true, parsedArgs.threshold);

  logger.info(`Multisig Account: ${JSON.stringify(multisigAccount)}`);

  const accountMultisigsRelationsPromises = allSignatoriesAccounts.map(member => checkAndGetAccountMultisig(multisigAccount.id, member.id));
  const accountMultisigsRelations = await Promise.all(accountMultisigsRelationsPromises);

  logger.info(`Account Multisigs Relations: ${JSON.stringify(accountMultisigsRelations)}`);

  for (const account of allSignatoriesAccounts) {
    await account.save();
  }

  await multisigAccount.save();

  for (const accountMultisigRelation of accountMultisigsRelations) {
    await accountMultisigRelation.save();
  }
}
