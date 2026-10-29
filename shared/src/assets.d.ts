// Vite `?url` imports (resolved by the phone and desktop builds)
declare module '*?url' {
  const url: string;
  export default url;
}
