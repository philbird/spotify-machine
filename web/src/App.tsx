import { NavLink, Route, Routes } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { Changelog } from './pages/Changelog';
import { Playlists, PlaylistDetail } from './pages/Playlists';

export function App() {
  return (
    <div className="layout">
      <nav className="side">
        <h1>Spotify Machine</h1>
        <ul>
          <li><NavLink to="/" end>Dashboard</NavLink></li>
          <li><NavLink to="/playlists">Playlists</NavLink></li>
          <li><NavLink to="/changelog">Changelog</NavLink></li>
          <li><NavLink to="/settings">Settings</NavLink></li>
        </ul>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/playlists" element={<Playlists />} />
          <Route path="/playlists/:id" element={<PlaylistDetail />} />
          <Route path="/changelog" element={<Changelog />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
