import React, { useEffect, useState, useCallback } from 'react';
import './styles/others-ll.css';

const OTHERS_LINKS = [
    { label: 'hakkeltamas 🖤', url: 'https://itk.hakkeltamas.hu/' },
    { label: 'hudes ☁️', url: 'https://drive.google.com/drive/folders/1Mcsi-VZUb1PcdKfhHFXn3JHNiRei28BO' },
    { label: 'vecha ☁️', url: 'https://mega.nz/folder/kYEiST5A#tdOn3s5WDauUS1mkhUAgDQ' },
    { label: 'PPKE WIKI 🅦', url: 'https://users.itk.ppke.hu/~marri1/' },
];



function getDomain(u) {
    try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; }

    return (
        <div className="others-ll">
            {/* Szigorúan scope-olt stílusok, hogy a formázás ne "folyjon szét" */}
           

            <div className="others-ll__container">
                {/* Fő szekció, felül a További linkek gombbal */}
                <Section
                    title="Titkos linkek"
                    links={OTHERS_LINKS}
                />
            </div>
            )}
        </div>
    );
}
