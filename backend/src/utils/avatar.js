export function getRandomAvatar() {
  const avatars = [
    "/avatars/image1.png",
    "/avatars/image2.jpg",
    "/avatars/image3.jpg",
    "/avatars/image4.jpg",
    "/avatars/image5.png",
  ];
  return avatars[Math.floor(Math.random() * avatars.length)];
}
