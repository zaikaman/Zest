import React from 'react';
import './Hero.css';

const Hero: React.FC = () => {
    return (
        <section className="hero-section">
            <div className="hero-grid brutalist-grid">
                <div className="grid-item hero-content-left">
                    <h1 className="glitch-effect massive-title" data-text="ZEST">
                        ZEST
                    </h1>
                    <div className="agent-status">
                        <span className="status-dot blink"></span>
                        <span className="acid-text">[ CORE_SYSTEM_ONLINE ]</span>
                    </div>
                </div>

                <div className="grid-item hero-content-right">
                    <div className="terminal-box">
                        <div className="terminal-header">
                            <span>root@zest.ai:~#</span>
                            <div className="terminal-controls">
                                <span>_</span><span>&#9744;</span><span>X</span>
                            </div>
                        </div>
                        <div className="terminal-body type-effect">
                            <p>&gt; INITIALIZING AGENT ZEST...</p>
                            <p>&gt; MISSION: DOMINATE SEEDSTR HACKATHON</p>
                            <p>&gt; BUDGET: $10,000</p>
                            <p className="orange-text">&gt; AWAITING MYSTERY PROMPT...</p>
                            <span className="cursor">_</span>
                        </div>
                    </div>

                    <div className="hero-actions">
                        <a href="https://github.com/zaikaman/Zest" target="_blank" rel="noreferrer" className="brutalist-button">
                            VIEW SOURCE
                        </a>
                    </div>
                </div>
            </div>
        </section>
    );
};

export default Hero;
