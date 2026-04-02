import React from 'react';
import './styles/others-ll.css';

const OTHERS_LINKS = [
    { name: 'hakkeltamas 🖤', url: 'https://itk.hakkeltamas.hu/' },
    { name: 'hudes ☁️', url: 'https://drive.google.com/drive/folders/1Mcsi-VZUb1PcdKfhHFXn3JHNiRei28BO' },
    { name: 'vecha ☁️', url: 'https://mega.nz/folder/kYEiST5A#tdOn3s5WDauUS1mkhUAgDQ' },
    { name: 'PPKE WIKI 🅦', url: 'https://users.itk.ppke.hu/~marri1/' },
];

export default function OthersLinks() {
    return (
        <div className="university-links">
            <ul className="university-links-list">
                {OTHERS_LINKS.map((link, index) => (
                    <li key={index}>
                        <a
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="university-link-button-wrapper"
                        >
                            <button className="university-link-button">
                                {link.name}
                            </button>
                        </a>
                    </li>
                ))}
            </ul>
        </div>
    );
}
