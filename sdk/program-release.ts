import { Connection, PublicKey } from "@solana/web3.js";

const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** Verify loader-v3 linkage, authority, and executable bytes before funding. */
export async function readProgramRelease(
  connection: Connection,
  program: PublicKey,
  artifact: Buffer,
) {
  if (!artifact.length) throw new Error("empty local SBF artifact");
  const [dataAddress] = PublicKey.findProgramAddressSync(
    [program.toBuffer()],
    loader,
  );
  const [entry, data] = await connection.getMultipleAccountsInfo([
    program,
    dataAddress,
  ]);
  if (
    !entry?.executable ||
    !entry.owner.equals(loader) ||
    entry.data.length !== 36 ||
    entry.data.readUInt32LE() !== 2 ||
    !entry.data.subarray(4).equals(dataAddress.toBuffer())
  )
    throw new Error("invalid program loader linkage");
  if (
    !data ||
    data.executable ||
    !data.owner.equals(loader) ||
    data.data.length < 45 ||
    data.data.readUInt32LE() !== 3 ||
    data.data[12] !== 1
  )
    throw new Error("cannot attest upgrade authority");
  const bytes = data.data.subarray(45);
  return {
    authority: new PublicKey(data.data.subarray(13, 45)),
    matches:
      bytes.subarray(0, artifact.length).equals(artifact) &&
      bytes.subarray(artifact.length).every((b) => b === 0),
  };
}
