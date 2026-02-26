import React from 'react';
import './AgentSpecs.css';

const AgentSpecs: React.FC = () => {
    return (
        <section className="specs-section">
            <div className="brutalist-grid">
                <div className="grid-item specs-header">
                    <h2 className="section-title">
                        <span className="highlighter-text">_</span>02 AGENT SPECS
                    </h2>
                </div>

                <div className="grid-item specs-details">
                    <div className="specs-grid">
                        <div className="spec-card">
                            <div className="spec-icon">[F]</div>
                            <h3>FUNCTIONALITY</h3>
                            <p>
                                Engineered to handle complex code generation and front-end interface builds.
                                Strict minimum of 5/10 required to pass initial judging. Zest aims for a flawless 10.
                            </p>
                        </div>

                        <div className="spec-card highlight-card">
                            <div className="spec-icon acid-text">[D]</div>
                            <h3 className="acid-text">DESIGN</h3>
                            <p>
                                Zero tolerance for generic "AI slop". Generates distinctive, production-grade
                                interfaces with extreme aesthetic commitment and brutal efficiency.
                            </p>
                        </div>

                        <div className="spec-card">
                            <div className="spec-icon">[S]</div>
                            <h3>SPEED</h3>
                            <p>
                                Optimized execution loops for rapid zip generation. Time is money. $10k to be exact.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
};

export default AgentSpecs;
