import { MultisigArgs } from "../types";
import { SubstrateExtrinsic } from "@subql/types";
import { checkAndGetAccount } from "../../utils/checkAndGetAccount";
import { checkAndGetAccountMultisig } from "../../utils/checkAndGetAccountMultisig";
import { u8aToHex } from "@polkadot/util";
import { decodeAddress, createKeyMultiAddress } from "../../utils";
import { CreateCallVisitorBuilder, CreateCallWalk, VisitedCall } from "subquery-call-visitor";
import { EventStatus, MultisigEvent, MultisigOperation, OperationStatus } from "../../types";
import { generateEventId, generateOperationId, getBlockCreated, getDataFromCall, getDataFromEvent, getIndexCreated, timestamp } from "../../utils/operations";
import { AccountId, DispatchResult, Timepoint } from "@polkadot/types/interfaces";
import { AnyTuple, CallBase } from "@polkadot/types/types";

const callWalk = CreateCallWalk()
const multisigVisitor = CreateCallVisitorBuilder()
  .on('multisig', 'asMulti', handleApproveMultisigCall)
  .on('multisig', 'asMultiThreshold1', handleApproveMultisigCall)
  .on('multisig', 'approveAsMulti', handleApproveMultisigCall)
  .on('multisig', 'cancelAsMulti', handleCancelMultisigCall)
  .ignoreFailedCalls(true)
  .build();

export async function handleMultisigInProxy(extrinsic: SubstrateExtrinsic) {
  callWalk.walk(extrinsic, multisigVisitor)
}

export async function handleMultisigCall(
  extrinsic: SubstrateExtrinsic
): Promise<void> {
  const {
    args: { threshold, other_signatories },
  } = extrinsic.extrinsic.method.toHuman() as unknown as MultisigArgs;

  const signer = extrinsic.extrinsic.signer.toString();
  const allSignatories = [...other_signatories, signer];
  const signatoriesAccountsPromises = allSignatories.map((signatory) =>
    checkAndGetAccount(u8aToHex(decodeAddress(signatory)))
  );
  const allSignatoriesAccounts = await Promise.all(signatoriesAccountsPromises);
  const multisigAddress = createKeyMultiAddress(allSignatories, threshold);
  const multisigAccount = await checkAndGetAccount(
    u8aToHex(decodeAddress(multisigAddress)),
    true,
    threshold
  );
  const accountMultisigsPromise = allSignatoriesAccounts.map((member) =>
    checkAndGetAccountMultisig(multisigAccount.id, member.id)
  );
  const accountMultisig = await Promise.all(accountMultisigsPromise);

  await Promise.all(allSignatoriesAccounts.map((member) => member.save()));
  await multisigAccount.save();
  await Promise.all(
    accountMultisig.map((accountMultisig) => accountMultisig.save())
  );

  await callWalk.walk(extrinsic, multisigVisitor)
}

async function getTransaction(visitedCall: VisitedCall): Promise<MultisigOperation | undefined> {
  const call = getDataFromCall<CallBase<AnyTuple>>(visitedCall.call, 'call');

  const call_hash = getDataFromCall<Uint8Array>(visitedCall.call, 'callHash');
  const callHash = call_hash ? u8aToHex(call_hash) : call?.hash?.toHex();
  if (!callHash) return;

  const multisig = getMultisigAccountIdFromEvents(visitedCall);
  if (!multisig) return;

  const multisigAccountId = multisig.toHex()

  const timepoint = getDataFromCall<Timepoint>(visitedCall.call, 'maybeTimepoint') ||
      getDataFromCall<Timepoint>(visitedCall.call, 'timepoint')

  const blockCreated = timepoint ? timepoint.height.toNumber() : getBlockCreated(visitedCall.extrinsic);
  const indexCreated = timepoint ? timepoint.index.toNumber() : getIndexCreated(visitedCall.extrinsic);

  const [existingOperation] = await MultisigOperation.getByFields([
    ['callHash', '=', callHash],
    ['blockCreated', '=', blockCreated],
    ['indexCreated', '=', indexCreated],
    ['accountId', '=', multisigAccountId]
  ], { limit: 1 });

  const operationId = generateOperationId(callHash, multisigAccountId, blockCreated, indexCreated);

  const newOperation = await MultisigOperation.create({
    ...existingOperation,
    id: operationId,
    section: call?.section,
    method: call?.method,
    callData: call?.toHex(),
    callHash,
    status: existingOperation?.status || OperationStatus.pending,
    accountId: multisigAccountId,
    depositor: u8aToHex(decodeAddress(visitedCall.origin)),
    blockCreated,
    indexCreated,
    timestamp: timestamp(visitedCall.extrinsic.block)
  });

  await newOperation.save();
  return newOperation;
}

async function updateOperationStatus(operation: MultisigOperation, status: OperationStatus) {
  const updatedOperation = await MultisigOperation.create({
    ...operation,
    status,
  });
  await updatedOperation.save();

  return updatedOperation;
}

async function createMultisigEvent(visitedCall: VisitedCall, operation: MultisigOperation, status: EventStatus) {
  const signer = u8aToHex(decodeAddress(visitedCall.origin))

  await MultisigEvent.create({
    id: generateEventId(operation.id, signer, status),
    accountId: signer,
    status,
    blockCreated: getBlockCreated(visitedCall.extrinsic),
    indexCreated: getIndexCreated(visitedCall.extrinsic),
    multisigId: operation.id,
    timestamp: timestamp(visitedCall.extrinsic.block)
  }).save();
}

export async function handleApproveMultisigCall(call: VisitedCall): Promise<void> {
  const operation = await getTransaction(call);
  if (!operation) return;

  await createMultisigEvent(call, operation, EventStatus.approve);

  const finalEvent = call.events.find(e => e.method === 'MultisigExecuted');
  if (!finalEvent) return;

  const result = getDataFromEvent<DispatchResult>(finalEvent, 'result', 4);
  const status = result?.isOk ? OperationStatus.executed : OperationStatus.error;
  await updateOperationStatus(operation, status);
}

export async function handleCancelMultisigCall(visitedCall: VisitedCall): Promise<void> {
  const timepoint = getDataFromCall<Timepoint>(visitedCall.call, 'timepoint')
  const callHash = getDataFromCall<Uint8Array>(visitedCall.call, 'callHash')

  if (!timepoint || !callHash) return;

  const operation = await getTransaction(visitedCall);

  if (!operation) return;

  const updatedOperation = await updateOperationStatus(operation, OperationStatus.cancelled);
  await createMultisigEvent(visitedCall, updatedOperation, EventStatus.reject);
}

function getMultisigAccountIdFromEvents(visitedCall: VisitedCall): AccountId | undefined {
  const multisigEvent = visitedCall.events.find(e => {
    return ['MultisigExecuted', 'NewMultisig', 'MultisigApproval', 'MultisigCancelled'].includes(e.method)
  });

  if (!multisigEvent) return;

  const possibleIndex = multisigEvent.method === 'NewMultisig' ? 1 : 2
  const multisig = getDataFromEvent<AccountId>(multisigEvent, 'multisig', possibleIndex)

  return multisig;
}
