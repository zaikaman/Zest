import Hero from './components/Hero';
import Marquee from './components/Marquee';
import AboutHackathon from './components/AboutHackathon';
import AgentSpecs from './components/AgentSpecs';
import CustomCursor from './components/CustomCursor';
import './index.css';

function App() {
  return (
    <>
      <CustomCursor />
      <div className="app-container">
        <header className="container" style={{ padding: '2rem 5%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: 'var(--structural-border)' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 'bold' }}>AGENT_ZEST // 01</div>
          <div style={{ color: 'var(--acid-yellow)' }}>[ SEEDSTR.IO ]</div>
        </header>

        <main className="container">
          <Hero />
        </main>

        <Marquee text="SEEDSTR AI HACKATHON // $10K PRIZE POOL // NO HUMAN JUDGES // MYSTERY PROMPT // " />

        <div className="container">
          <AboutHackathon />
          <AgentSpecs />
        </div>

        <Marquee text="INITIATING CORE PROTOCOLS // AWAITING TARGET // READY TO DEPLOY // " reverse={true} />

        <footer className="container" style={{ padding: '4rem 5%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          <div>© 2026 ZEST AGENT</div>
          <a href="https://discord.gg/H9DSeXsz" target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>COMM LINK [DISCORD]</a>
          <div>END LOG.</div>
        </footer>
      </div>
    </>
  );
}

export default App;
