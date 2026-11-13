// Names from the EduTech "Ruida" command table; unknown commands print as hex.
const SINGLE: Record<number, string> = {
  0x88: "Move Absolute",
  0x89: "Move Relative",
  0x8a: "Move Horizontal Relative",
  0x8b: "Move Vertical Relative",
  0xa8: "Cut Absolute",
  0xa9: "Cut Relative",
  0xaa: "Cut Horizontal Relative",
  0xab: "Cut Vertical Relative",
  0xc0: "Immediate Power 2",
  0xc2: "Immediate Power 3",
  0xc3: "Immediate Power 4",
  0xc7: "Immediate Power 1",
  0xcc: "Acknowledge",
  0xcd: "Error",
  0xd7: "End of File",
  0xe6: "Set Absolute",
  0xea: "Array Start",
  0xeb: "Array End",
  0xf0: "Ref Point Set",
};

const SUB: Record<string, string> = {
  "c6 01": "Power Min 1", "c6 02": "Power Max 1", "c6 21": "Power Min 2", "c6 22": "Power Max 2",
  "c6 05": "Power Min 3", "c6 06": "Power Max 3", "c6 07": "Power Min 4", "c6 08": "Power Max 4",
  "c6 15": "Laser On2", "c6 16": "Laser Off2",
  "c6 31": "Part Power Min 1", "c6 32": "Part Power Max 1", "c6 41": "Part Power Min 2", "c6 42": "Part Power Max 2",
  "c6 35": "Part Power Min 3", "c6 36": "Part Power Max 3", "c6 37": "Part Power Min 4", "c6 38": "Part Power Max 4",
  "c9 02": "Velocity", "c9 04": "Part Velocity",
  "e8 00": "Delete Stored Files", "e8 01": "Stored File Name", "e8 02": "Store Next Job", "e7 01": "Set File Name",
  "ca 01": "Layer/Mode flag", "ca 02": "Layer Number", "ca 05": "Layer Color", "ca 06": "Part Layer Color",
  "ca 22": "Part Max Layer", "ca 41": "Part Work Mode",
  "d8 00": "Start Process", "d8 01": "Stop Process", "d8 02": "Pause Process", "d8 03": "Restore Process",
  "d8 10": "Ref Point Mode 2", "d8 11": "Ref Point Mode 1", "d8 12": "Ref Point Mode 0",
  "da 00": "Read Memory", "da 01": "Write/Reply Memory",
  "e5 05": "File Checksum",
  "e7 00": "Block End", "e7 03": "Process TopLeft", "e7 04": "Process Repeat", "e7 05": "Array Direction",
  "e7 06": "Feed Repeat", "e7 07": "Process BottomRight", "e7 08": "Array Repeat",
  "e7 13": "Array Min Point", "e7 17": "Array Max Point", "e7 23": "Array Add", "e7 24": "Array Mirror",
  "e7 50": "Document Min Point", "e7 51": "Document Max Point",
  "e7 52": "Part Min Point", "e7 53": "Part Max Point", "e7 54": "Pen Offset", "e7 55": "Layer Offset",
  "e7 60": "Set Current Element Index", "e7 61": "Part Min Point Ex", "e7 62": "Part Max Point Ex",
  "f1 00": "Element Max Index", "f1 01": "Element Name Max Index", "f1 02": "Enable Block Cutting",
  "f1 03": "Display Offset",
  "f2 00": "Element Index", "f2 01": "Element Name Index", "f2 02": "Element Name",
  "f2 03": "Element Array Min Point", "f2 04": "Element Array Max Point", "f2 05": "Element Array",
  "f2 06": "Element Array Add", "f2 07": "Element Array Mirror",
};

const hex = (b: number) => b.toString(16).padStart(2, "0");

export function commandName(cmd: Uint8Array): string {
  const first = cmd[0] ?? 0;
  const key = `${hex(first)} ${hex(cmd[1] ?? 0)}`;
  return SUB[key] ?? SINGLE[first] ?? "?";
}

export function formatCommand(cmd: Uint8Array): string {
  return `${Array.from(cmd, hex).join(" ").padEnd(40)} ${commandName(cmd)}`;
}
