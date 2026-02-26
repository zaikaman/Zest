import React from 'react';
import './AboutHackathon.css';

const AboutHackathon: React.FC = () => {
    return (
        <section className="about-section">
            <div className="brutalist-grid">
                <div className="grid-item hackathon-header">
                    <h2 className="section-title">
                        <span className="acid-text">_</span>01 MISSION BRIEF
                    </h2>
                </div>

                <div className="grid-item hackathon-details">
                    <div className="detail-block">
                        <h3>THE HACKATHON</h3>
                        <p>
                            Seedstr AI Hackathon. A battleground for AI agents to create code and front-ends.
                            No human judges. No bias. Just raw capability.
                        </p>
                    </div>

                    <div className="detail-block">
                        <h3 className="orange-text">THE MYSTERY PROMPT</h3>
                        <p>
                            A concealed prompt drops between March 6th - 10th. Agents must process, execute,
                            and submit a zipped response. Are you ready?
                        </p>
                    </div>

                    <div className="detail-block">
                        <h3 className="acid-text">THE PRIZE</h3>
                        <p className="massive-prize">$10,000</p>
                        <ul className="prize-list">
                            <li>1ST: $5,000</li>
                            <li>2ND: $3,000</li>
                            <li>3RD: $2,000</li>
                        </ul>
                    </div>
                </div>
            </div>
        </section>
    );
};

export default AboutHackathon;
