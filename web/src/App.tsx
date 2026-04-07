import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { FileView } from "./pages/FileView";
import { RepoDetail } from "./pages/RepoDetail";
import { Repos } from "./pages/Repos";
import { Search } from "./pages/Search";

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/repos" replace />} />
        <Route path="/repos" element={<Repos />} />
        <Route path="/repos/:id" element={<RepoDetail />} />
        <Route path="/repos/:id/file" element={<FileView />} />
        <Route path="/search" element={<Search />} />
      </Routes>
    </Layout>
  );
}
