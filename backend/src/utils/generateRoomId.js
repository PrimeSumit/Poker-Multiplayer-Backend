export function generateRoomId(region = "IN") {
  const randomNum = Math.floor(100000 + Math.random() * 900000); // 6-digit
  return `${region}${randomNum}`;
}
