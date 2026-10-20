import ClaimManagerPage from "./claimManager/ClaimManagerPage";

// Route /content-id/claims. The page itself lives in ./claimManager so this
// entry point stays stable for App.jsx while the implementation evolves.
export default function ContentIdClaimPage() {
  return <ClaimManagerPage />;
}
