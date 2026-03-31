import { useState } from 'react';
import LandingPage from './pages/LandingPage';
import OptionsPage from './pages/OptionsPage';
import { type SheetData } from './utils/csv';

type Page = 'landing' | 'options';

function App() {
  const [page, setPage] = useState<Page>('landing');
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [fileName, setFileName] = useState('');

  function handleNext(parsedSheets: SheetData[], name: string) {
    setSheets(parsedSheets);
    setFileName(name);
    setPage('options');
  }

  function handleReset() {
    setSheets([]);
    setFileName('');
    setPage('landing');
  }

  return (
    <div className="min-h-screen flex flex-col">
      {page === 'landing' && <LandingPage onNext={handleNext} />}
      {page === 'options' && (
        <OptionsPage
          sheets={sheets}
          fileName={fileName}
          onNewSheet={handleReset}
          onBack={handleReset}
        />
      )}
    </div>
  );
}

export default App;
